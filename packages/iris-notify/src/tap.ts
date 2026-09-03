import { Service } from "@deepseek-ai/cordis";

/**
 * @rlm/iris-notify/tap — tap into iris events and emit notifications.
 *
 * This service listens for other iris events (e.g. command completion,
 * delegate milestones) and fires desktop notifications for them.
 */

export interface TapConfig {
  /** Emit a notification when a delegate task completes. */
  notifyOnTaskDone?: boolean;
  /** Emit a notification when a delegate task fails. */
  notifyOnTaskFail?: boolean;
  /** Minimum elapsed seconds before a notification fires. */
  minDuration?: number;
}

export class IrisNotifyTap extends Service {
  static inject = ["rlmSdk", "irisNotify"] as const;
  static provide = "irisNotifyTap" as const;

  declare config: TapConfig;

  private sdk: any;
  private notify: any;
  private taskStartTimes: Map<string, number> = new Map();

  constructor(goog: any, config: TapConfig = {}) {
    super(goog, undefined as any);
    this.config = config;
    this.sdk = goog.get("rlmSdk");
    this.notify = goog.get("irisNotify");
  }

  async [Service.init]() {
    // Wire up event listeners if the SDK exposes them.
    // The tap is a no-op until rlmSd or other components emit events here.
    const sdk = this.sdk;
    if (!sdk) return;

    // Placeholder: real event wiring depends on SDK event surface.
    // For now the tap is live and ready for hooks that arrive later.
  }

  /**
   * Record that a task started, so elapsed time can be measured on completion.
   */
  trackTaskStart(taskId: string): void {
    this.taskStartTimes.set(taskId, Date.now());
  }

  /**
   * Fire a notification for a task completion, subject to minDuration.
   */
  async onTaskDone(taskId: string, title?: string): Promise<void> {
    if (!this.config.notifyOnTaskDone) return;
    const start = this.taskStartTimes.get(taskId);
    if (start !== undefined) {
      const elapsed = (Date.now() - start) / 1000;
      const min = this.config.minDuration ?? 0;
      if (elapsed < min) return;
    }
    await this.notify?.notify({
      title: title ?? "Task done",
      body: taskId,
      sound: true,
    });
    this.taskStartTimes.delete(taskId);
  }

  /**
   * Fire a notification for a task failure.
   */
  async onTaskFail(taskId: string, error?: string): Promise<void> {
    if (!this.config.notifyOnTaskFail) return;
    await this.notify?.notify({
      title: "Task failed",
      body: error ?? taskId,
      sound: true,
    });
    this.taskStartTimes.delete(taskId);
  }
}

export default IrisNotifyTap;
