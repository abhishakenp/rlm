/**
 * @rlm/eleksha — Eleksha connection plugin for RLM.
 */
import { Service } from "@deepseek-ai/cordis";
// Relative, not absolute. This was an absolute path into one developer's
// home directory, which is unresolvable on any other machine and is also
// why `eleksha-connection` was declared as a `file:` dependency pointing at
// a single .cjs file — a shape npm and bun both reject, so no `bun install`
// in this repository could complete at all.
import ElekshaConnection from "../../../eleksha-connection.cjs";

const SOCKET_PATH = "/tmp/lightbol.sock";

export interface RlmElekshaConfig {
  socketPath?: string;
  autoConnect?: boolean;
}

export class RlmElekshaService extends Service {
  static inject = ["rlmConfig"] as const;
  static provide = "rlmEleksha" as const;

  private connection: ElekshaConnection;
  private connecting = false;
  declare config: RlmElekshaConfig;

  constructor(ctx: any, config: RlmElekshaConfig = {}) {
    super(ctx, undefined as any);
    this.config = config;
    this.connection = new ElekshaConnection();
  }

  private get socketPath(): string {
    return this.config.socketPath ?? SOCKET_PATH;
  }

  async [Service.init]() {
    this.ctx.logger?.info(`rlm-eleksha: init (socket=${this.socketPath})`);
    // Cordis never calls `[Symbol.dispose]`; this effect is what runs when the fiber goes.
    (this.ctx as any).effect(() => () => {
      this.stopped = true;
      if (this.retryTimer) clearTimeout(this.retryTimer);
      this.disconnect();
    }, "rlm-eleksha retire");
    // A missing socket is a state, not a failure: throwing here failed the row,
    // and one failed overlay row used to roll back EVERY overlay row. Keep
    // trying in the background instead (5s, doubling to 60s).
    if (this.config.autoConnect !== false) void this.connectWithRetry(5_000);
  }

  private stopped = false;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private async connectWithRetry(delay: number): Promise<void> {
    if (this.stopped) return;
    try {
      await this.connect();
    } catch {
      if (this.stopped) return;
      this.retryTimer = setTimeout(() => void this.connectWithRetry(Math.min(delay * 2, 60_000)), delay);
      (this.retryTimer as any).unref?.();
    }
  }

  async connect(): Promise<boolean> {
    if (this.connection.isConnected()) return true;
    if (this.connecting) return false;
    this.connecting = true;
    try {
      const result = await this.connection.connect(this.socketPath);
      this.ctx.logger?.info(`rlm-eleksha: connected to ${this.socketPath}`);
      return result;
    } catch (error) {
      this.ctx.logger?.warn(`rlm-eleksha: not connected (${error}) — retrying`);
      throw error;
    } finally {
      this.connecting = false;
    }
  }

  isConnected(): boolean {
    return this.connection.isConnected();
  }

  send(data: string): boolean {
    return this.connection.send(data);
  }

  disconnect(): void {
    this.connection.disconnect();
    this.ctx.logger?.info("rlm-eleksha: disconnected");
  }

  // No `[Symbol.dispose]`: Cordis never calls it; see the effect in init.
}

export default RlmElekshaService;
export const name = "rlm-eleksha";
export { RlmElekshaService as RlmEleksha };
