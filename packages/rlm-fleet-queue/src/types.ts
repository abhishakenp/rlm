/**
 * Fleet Queue Types
 * 
 * Core types for the issues-as-queue design.
 * When fleet admission would exceed a concurrency ceiling, 
 * the system files a GitHub Issue instead of dispatching a run.
 */

export interface QueueConfig {
  /** Maximum number of parallel runs */
  maxConcurrency: number;
  /** GitHub label for queued issues */
  queueLabel: string;
  /** GitHub label for in-progress issues */
  inProgressLabel: string;
  /** GitHub label for completed issues */
  completedLabel: string;
  /** Repository owner */
  repoOwner: string;
  /** Repository name */
  repoName: string;
  /** GitHub API token */
  githubToken: string;
  /** API base URL (defaults to https://api.github.com) */
  apiBaseUrl?: string;
}

export interface QueueEntry {
  /** GitHub issue number */
  issueNumber: number;
  /** Task prompt/description */
  taskPrompt: string;
  /** When the issue was created */
  createdAt: Date;
  /** Assigned run ID (when promoted) */
  assignedRunId?: string;
  /** Title of the issue */
  title: string;
}

export interface QueueAdmissionResult {
  /** Whether the task was admitted directly */
  admitted: boolean;
  /** Run ID if admitted (immediate dispatch) */
  runId?: string;
  /** Issue number if queued */
  issueNumber?: number;
  /** Reason for the decision */
  reason: string;
}

export interface RunMetadata {
  /** Unique run identifier */
  runId: string;
  /** Linked GitHub issue number */
  issueNumber: number;
  /** URL to the GitHub issue */
  issueUrl: string;
  /** When the run was dispatched */
  dispatchedAt: string;
  /** When the run completed */
  completedAt?: string;
  /** Run status */
  status: 'running' | 'success' | 'failed' | 'cancelled';
  /** Repository URL */
  repoUrl: string;
  /** Run URL (GitHub Actions run URL) */
  runUrl?: string;
}

export interface IssueState {
  /** State: open, in_progress, completed */
  state: 'queued' | 'in_progress' | 'completed';
  /** Associated run ID */
  runId?: string;
  /** Run URL for linking */
  runUrl?: string;
}

export interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  state: string;
  labels: string[];
  created_at: string;
  updated_at: string;
}

export interface GitHubComment {
  id: number;
  body: string;
  created_at: string;
}

export interface PromotionResult {
  success: boolean;
  issueNumber: number;
  runId?: string;
  error?: string;
}
