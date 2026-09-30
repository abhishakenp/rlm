/**
 * S2 Queue-Drain Scheduler
 * 
 * Implements the queue-drain scheduler pattern:
 * - Monitors active run count against concurrency ceiling
 * - Promotes queued issues to runs when slots become available
 * - Posts run links as comments on issues
 * - Closes issues when runs complete
 */

import { GitHubApiHandler } from './github-api.js';
import { FleetQueue } from './queue.js';
import type { 
  QueueConfig, 
  QueueEntry, 
  PromotionResult,
  RunMetadata 
} from './types.js';

export interface QueueDrainConfig extends QueueConfig {
  /** Interval between sweeps in milliseconds (default: 120000 = 2 min) */
  sweepIntervalMs?: number;
  /** Maximum issues to process per sweep */
  maxPerSweep?: number;
  /** Callback when issue is promoted */
  onPromote?: (entry: QueueEntry, result: PromotionResult) => void;
  /** Callback when run completes */
  onComplete?: (issueNumber: number, metadata: RunMetadata) => void;
}

export class QueueDrainScheduler {
  private queue: FleetQueue;
  private config: QueueDrainConfig;
  private sweepIntervalId?: NodeJS.Timeout;
  private isRunning = false;

  constructor(config: QueueDrainConfig) {
    this.config = {
      sweepIntervalMs: 120000,
      maxPerSweep: 3,
      ...config,
    };
    this.queue = new FleetQueue(config);
  }

  /**
   * Start the periodic sweep
   */
  start(): void {
    if (this.isRunning) {
      console.log('QueueDrainScheduler already running');
      return;
    }

    this.isRunning = true;
    console.log('Starting QueueDrainScheduler...');
    
    this.sweep();
    
    this.sweepIntervalId = setInterval(() => {
      this.sweep();
    }, this.config.sweepIntervalMs!);
  }

  /**
   * Stop the periodic sweep
   */
  stop(): void {
    if (this.sweepIntervalId) {
      clearInterval(this.sweepIntervalId);
      this.sweepIntervalId = undefined;
    }
    this.isRunning = false;
    console.log('QueueDrainScheduler stopped');
  }

  /**
   * Run a single sweep
   */
  async sweep(): Promise<void> {
    console.log('Running queue drain sweep...');
    
    try {
      const activeRunCount = await this.getActiveRunCount();
      console.log('Active runs:', activeRunCount, '/', this.config.maxConcurrency);
      
      const slotsAvailable = Math.max(0, this.config.maxConcurrency - activeRunCount);
      
      if (slotsAvailable === 0) {
        console.log('No slots available, skipping sweep');
        return;
      }
      
      const queued = await this.queue.getQueuedEntries();
      console.log('Queued issues:', queued.length);
      
      if (queued.length === 0) {
        console.log('No queued issues');
        return;
      }
      
      const toProcess = Math.min(slotsAvailable, this.config.maxPerSweep!, queued.length);
      console.log('Processing', toProcess, 'issues');
      
      for (let i = 0; i < toProcess; i++) {
        const entry = queued[i];
        console.log('Promoting issue #', entry.issueNumber, ':', entry.title);
        
        const result = await this.queue.promoteNext(
          activeRunCount + i,
          async (taskPrompt, issueNumber) => {
            return await this.dispatchRun(taskPrompt, issueNumber);
          }
        );
        
        if (result.success) {
          console.log('Promoted issue #', entry.issueNumber, 'to run', result.runId);
          
          if (this.config.onPromote) {
            this.config.onPromote(entry, result);
          }
        } else {
          console.error('Failed to promote issue #', entry.issueNumber, ':', result.error);
        }
      }
      
    } catch (error) {
      console.error('Sweep error:', error);
    }
  }

  /**
   * Handle run completion
   */
  async handleRunComplete(issueNumber: number, metadata: RunMetadata): Promise<void> {
    console.log('Handling run completion for issue #', issueNumber);
    
    try {
      await this.queue.onRunComplete(issueNumber, metadata);
      
      if (this.config.onComplete) {
        this.config.onComplete(issueNumber, metadata);
      }
    } catch (error) {
      console.error('Error handling run completion:', error);
    }
  }

  /**
   * Get current active run count
   */
  private async getActiveRunCount(): Promise<number> {
    const api = new GitHubApiHandler(this.config);
    
    try {
      const runs = await api.getActiveRuns();
      return runs.length;
    } catch {
      console.error('Failed to get active run count, assuming 0');
      return 0;
    }
  }

  /**
   * Dispatch a run for the given task
   */
  private async dispatchRun(
    taskPrompt: string, 
    issueNumber: number
  ): Promise<{ runId: string; runUrl?: string }> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const runId = 'run-' + timestamp + '-' + issueNumber;
    
    console.log('Would dispatch run for issue #', issueNumber);
    
    return {
      runId,
      runUrl: undefined,
    };
  }

  /**
   * Get current queue status
   */
  async getStatus(): Promise<{
    activeRuns: number;
    maxConcurrency: number;
    queueDepth: number;
    isRunning: boolean;
  }> {
    const activeRuns = await this.getActiveRunCount();
    const queueDepth = await this.queue.getQueueDepth();
    
    return {
      activeRuns,
      maxConcurrency: this.config.maxConcurrency,
      queueDepth,
      isRunning: this.isRunning,
    };
  }
}

export function createQueueDrainScheduler(config: QueueDrainConfig): QueueDrainScheduler {
  return new QueueDrainScheduler(config);
}
