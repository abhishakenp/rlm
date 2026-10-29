/**
 * Fleet Queue Module
 * 
 * Core admission logic for the issues-as-queue design.
 * When fleet admission would exceed a concurrency ceiling, 
 * the system files a GitHub Issue instead of dispatching a run.
 */

import { GitHubApiHandler } from './github-api.js';
import type { 
  QueueConfig, 
  QueueAdmissionResult, 
  RunMetadata,
  QueueEntry,
  PromotionResult
} from './types.js';

export class FleetQueue {
  private api: GitHubApiHandler;
  private config: QueueConfig;

  constructor(config: QueueConfig) {
    this.config = config;
    this.api = new GitHubApiHandler(config);
  }

  /**
   * Check if a task can be admitted or needs to be queued
   * 
   * @param activeRunCount Current number of active runs
   * @param taskPrompt The task to queue
   * @returns Admission result with either run ID or issue number
   */
  async checkAndAdmit(
    activeRunCount: number,
    taskPrompt: string
  ): Promise<QueueAdmissionResult> {
    // Check if we have capacity
    if (activeRunCount < this.config.maxConcurrency) {
      // Within limit - return admitted status
      const runId = this.generateRunId();
      return {
        admitted: true,
        runId,
        reason: `Within concurrency limit (${activeRunCount}/${this.config.maxConcurrency})`,
      };
    }

    // Exceeded limit - file issue
    const issueNumber = await this.api.createQueueIssue(taskPrompt);
    return {
      admitted: false,
      issueNumber,
      reason: `Concurrency exceeded (${activeRunCount}/${this.config.maxConcurrency}) - queued`,
    };
  }

  /**
   * Get the current queue depth (number of waiting issues)
   */
  async getQueueDepth(): Promise<number> {
    const issues = await this.api.getQueuedIssues();
    return issues.length;
  }

  /**
   * Get all queued entries
   */
  async getQueuedEntries(): Promise<QueueEntry[]> {
    return this.api.getQueuedIssues();
  }

  /**
   * Get in-progress entries
   */
  async getInProgressEntries(): Promise<QueueEntry[]> {
    return this.api.getInProgressIssues();
  }

  /**
   * Promote the next queued issue to an active run
   * 
   * @param activeRunCount Current number of active runs
   * @param dispatchFn Function to call to dispatch the actual run
   * @returns Promotion result
   */
  async promoteNext(
    activeRunCount: number,
    dispatchFn: (taskPrompt: string, issueNumber: number) => Promise<{ runId: string; runUrl?: string }>
  ): Promise<PromotionResult> {
    // Check if we have capacity
    if (activeRunCount >= this.config.maxConcurrency) {
      return {
        success: false,
        issueNumber: 0,
        error: 'No capacity available',
      };
    }

    // Get the oldest queued issue
    const queued = await this.api.getQueuedIssues();
    if (queued.length === 0) {
      return {
        success: false,
        issueNumber: 0,
        error: 'No queued issues',
      };
    }

    const nextIssue = queued[0];

    try {
      // Dispatch the run
      const dispatchResult = await dispatchFn(nextIssue.taskPrompt, nextIssue.issueNumber);
      
      // Update issue state to in-progress
      await this.api.updateIssueState(nextIssue.issueNumber, {
        state: 'in_progress',
        runId: dispatchResult.runId,
        runUrl: dispatchResult.runUrl,
      });

      // Add promotion comment
      const comment = GitHubApiHandler.formatPromotionComment(
        dispatchResult.runId,
        dispatchResult.runUrl
      );
      await this.api.addIssueComment(nextIssue.issueNumber, comment);

      return {
        success: true,
        issueNumber: nextIssue.issueNumber,
        runId: dispatchResult.runId,
      };
    } catch (error) {
      return {
        success: false,
        issueNumber: nextIssue.issueNumber,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Handle run completion - close the associated issue
   */
  async onRunComplete(
    issueNumber: number,
    metadata: RunMetadata
  ): Promise<void> {
    // Close the issue with completion details
    await this.api.closeQueueIssue(issueNumber, metadata);

    // Add completion comment
    const comment = GitHubApiHandler.formatCompletionComment(metadata);
    await this.api.addIssueComment(issueNumber, comment);
  }

  /**
   * Handle run failure
   */
  async onRunFailed(
    issueNumber: number,
    runId: string,
    error: string
  ): Promise<void> {
    const metadata: RunMetadata = {
      runId,
      issueNumber,
      issueUrl: `https://github.com/${this.config.repoOwner}/${this.config.repoName}/issues/${issueNumber}`,
      dispatchedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      status: 'failed',
      repoUrl: `https://github.com/${this.config.repoOwner}/${this.config.repoName}`,
    };

    // Close the issue with failure details
    await this.api.closeQueueIssue(issueNumber, metadata);

    // Add failure comment
    const comment = `## Run Failed

The associated run has failed.

### Failure Details

| Field | Value |
|-------|-------|
| **Run ID** | \`${runId}\` |
| **Error** | ${error} |
| **Failed at** | ${new Date().toISOString()} |

### Linked Issue

- **Issue**: #${issueNumber}
- **Issue URL**: ${metadata.issueUrl}

---
*This issue was closed automatically due to run failure.*
`;
    await this.api.addIssueComment(issueNumber, comment);
  }

  /**
   * Generate a unique run ID
   */
  private generateRunId(): string {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const random = Math.random().toString(36).substring(2, 8);
    return `run-${timestamp}-${random}`;
  }

  /**
   * Write run metadata to a file (for persistence across restarts)
   */
  static writeRunMetadata(path: string, metadata: RunMetadata): void {
    const fs = require('fs');
    const content = JSON.stringify(metadata, null, 2);
    fs.writeFileSync(path, content, 'utf-8');
  }

  /**
   * Read run metadata from a file
   */
  static readRunMetadata(path: string): RunMetadata | null {
    const fs = require('fs');
    try {
      const content = fs.readFileSync(path, 'utf-8');
      return JSON.parse(content);
    } catch {
      return null;
    }
  }
}

/**
 * Default configuration factory
 */
export function createFleetQueue(config: Partial<QueueConfig> & {
  githubToken: string;
  repoOwner: string;
  repoName: string;
}): FleetQueue {
  return new FleetQueue({
    maxConcurrency: config.maxConcurrency ?? 5,
    queueLabel: config.queueLabel ?? 'rlm-task',
    inProgressLabel: config.inProgressLabel ?? 'rlm-in-progress',
    completedLabel: config.completedLabel ?? 'rlm-completed',
    repoOwner: config.repoOwner,
    repoName: config.repoName,
    githubToken: config.githubToken,
    apiBaseUrl: config.apiBaseUrl,
  });
}
