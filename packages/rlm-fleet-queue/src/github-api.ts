/**
 * GitHub API Handler
 * 
 * Handles all GitHub API interactions for the fleet queue system.
 */

import type { 
  QueueConfig, 
  QueueEntry, 
  GitHubIssue, 
  GitHubComment,
  IssueState,
  RunMetadata
} from './types.js';

export class GitHubApiHandler {
  private config: QueueConfig;
  private baseUrl: string;

  constructor(config: QueueConfig) {
    this.config = config;
    this.baseUrl = config.apiBaseUrl || 'https://api.github.com';
  }

  private get headers(): Record<string, string> {
    return {
      'Authorization': `token ${this.config.githubToken}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
    };
  }

  private async request<T>(
    method: string,
    path: string,
    body?: object
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const options: RequestInit = {
      method,
      headers: this.headers,
    };

    if (body) {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `GitHub API error: ${response.status} ${response.statusText} - ${errorText}`
      );
    }

    // Handle 204 No Content
    if (response.status === 204) {
      return {} as T;
    }

    return response.json() as Promise<T>;
  }

  /**
   * Create a new issue for queueing
   */
  async createQueueIssue(taskPrompt: string): Promise<number> {
    const title = `Task: ${taskPrompt.slice(0, 100)}${taskPrompt.length > 100 ? '...' : ''}`;
    const body = this.formatIssueBody(taskPrompt);

    const issue = await this.request<GitHubIssue>(
      'POST',
      `/repos/${this.config.repoOwner}/${this.config.repoName}/issues`,
      {
        title,
        body,
        labels: [this.config.queueLabel],
      }
    );

    return issue.number;
  }

  /**
   * Get all queued issues (open issues with queue label)
   */
  async getQueuedIssues(): Promise<QueueEntry[]> {
    const issues = await this.request<GitHubIssue[]>(
      'GET',
      `/repos/${this.config.repoOwner}/${this.config.repoName}/issues`,
      {
        labels: this.config.queueLabel,
        state: 'open',
        sort: 'created',
        direction: 'asc',
      }
    );

    return issues.map(issue => ({
      issueNumber: issue.number,
      taskPrompt: issue.body || '',
      createdAt: new Date(issue.created_at),
      title: issue.title,
    }));
  }

  /**
   * Get all in-progress issues
   */
  async getInProgressIssues(): Promise<QueueEntry[]> {
    const issues = await this.request<GitHubIssue[]>(
      'GET',
      `/repos/${this.config.repoOwner}/${this.config.repoName}/issues`,
      {
        labels: this.config.inProgressLabel,
        state: 'open',
        sort: 'created',
        direction: 'asc',
      }
    );

    return issues.map(issue => ({
      issueNumber: issue.number,
      taskPrompt: issue.body || '',
      createdAt: new Date(issue.created_at),
      title: issue.title,
    }));
  }

  /**
   * Get a single issue by number
   */
  async getIssue(issueNumber: number): Promise<GitHubIssue> {
    return this.request<GitHubIssue>(
      'GET',
      `/repos/${this.config.repoOwner}/${this.config.repoName}/issues/${issueNumber}`
    );
  }

  /**
   * Update issue state and labels
   */
  async updateIssueState(issueNumber: number, state: IssueState): Promise<void> {
    const updateBody: Record<string, unknown> = {};

    if (state.state === 'in_progress') {
      updateBody.labels = {
        add: [this.config.inProgressLabel],
        remove: [this.config.queueLabel],
      };
    } else if (state.state === 'completed') {
      updateBody.labels = {
        add: [this.config.completedLabel],
        remove: [this.config.inProgressLabel, this.config.queueLabel],
      };
    }

    await this.request(
      'PATCH',
      `/repos/${this.config.repoOwner}/${this.config.repoName}/issues/${issueNumber}`,
      updateBody
    );
  }

  /**
   * Close an issue with completion details
   */
  async closeQueueIssue(
    issueNumber: number,
    metadata: RunMetadata
  ): Promise<void> {
    const closeBody = {
      state: 'closed',
      labels: {
        add: [this.config.completedLabel],
        remove: [this.config.inProgressLabel, this.config.queueLabel],
      },
    };

    await this.request(
      'PATCH',
      `/repos/${this.config.repoOwner}/${this.config.repoName}/issues/${issueNumber}`,
      closeBody
    );
  }

  /**
   * Add a comment to an issue
   */
  async addIssueComment(issueNumber: number, comment: string): Promise<void> {
    await this.request(
      'POST',
      `/repos/${this.config.repoOwner}/${this.config.repoName}/issues/${issueNumber}/comments`,
      { body: comment }
    );
  }

  /**
   * Get comments on an issue
   */
  async getIssueComments(issueNumber: number): Promise<GitHubComment[]> {
    return this.request<GitHubComment[]>(
      'GET',
      `/repos/${this.config.repoOwner}/${this.config.repoName}/issues/${issueNumber}/comments`
    );
  }

  /**
   * Format issue body with task details
   */
  private formatIssueBody(taskPrompt: string): string {
    const timestamp = new Date().toISOString();
    return `## Task Queued

This task was queued because all fleet concurrent slots are occupied.

### Task Details

\`\`\`
${taskPrompt}
\`\`\`

### Queue Information

- **Queued at**: ${timestamp}
- **Status**: Waiting for available slot
- **Label**: \`${this.config.queueLabel}\`

### Workflow

A scheduled workflow will promote this issue to an active run when a slot becomes available.
The issue will be closed automatically when the run completes.

---
*This issue was created automatically by the Fleet Queue system.*
`;
  }

  /**
   * Format completion comment
   */
  static formatCompletionComment(metadata: RunMetadata): string {
    return `## Run Completed

This task has been completed.

### Run Details

| Field | Value |
|-------|-------|
| **Run ID** | \`${metadata.runId}\` |
| **Status** | ${metadata.status} |
| **Dispatched** | ${metadata.dispatchedAt} |
| **Completed** | ${metadata.completedAt || 'In progress'} |
| **Run URL** | ${metadata.runUrl || 'Not available'} |

### Linked Issue

- **Issue**: #${metadata.issueNumber}
- **Issue URL**: ${metadata.issueUrl}

---
*This issue was closed automatically when the run completed.*
`;
  }

  /**
   * Format promotion comment
   */
  static formatPromotionComment(runId: string, runUrl?: string): string {
    return `## Promotion Status

This issue has been promoted to an active run.

### Promotion Details

| Field | Value |
|-------|-------|
| **Status** | In Progress |
| **Promoted at** | ${new Date().toISOString()} |
| **Run ID** | \`${runId}\` |
| **Run URL** | ${runUrl || 'Check Actions tab'} |

The run will complete and link back to this issue when finished.
`;
  }
}
