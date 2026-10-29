/**
 * @rlm/fleet-queue
 * 
 * Fleet queue management with GitHub Issues as queue backend.
 * 
 * When fleet admission would exceed a concurrency ceiling, the system files
 * a GitHub Issue labeled with the queue label instead of dispatching a run.
 * A periodic workflow promotes queued issues to dispatched runs as slots
 * free up, closing the issue when the run completes and linking run↔issue.
 */

export { FleetQueue, createFleetQueue } from './queue.js';
export { GitHubApiHandler } from './github-api.js';
export type {
  QueueConfig,
  QueueEntry,
  QueueAdmissionResult,
  RunMetadata,
  IssueState,
  GitHubIssue,
  GitHubComment,
  PromotionResult,
} from './types.js';
