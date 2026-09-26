import { exec, execSync } from "child_process";
import * as fs from "fs";
import { Service } from "@deepseek-ai/cordis";
import { join } from "path";

// Spawn rlm-delegate as a child process and keep it running
export class DelegateSpawner extends Service {
  static provide = "iris-delegate-spawner" as const;
  static inject = ["rlmSdk"] as const;

  constructor(ctx: any) {
    super(ctx);
    // Cleanup was `[Service.dispose]`, which cordis 4 does not define — a method
    // named "undefined" that never ran, so the child outlived the row. The
    // effect's disposer is what cordis runs when the fiber goes.
    ctx.effect(() => () => void this.stopDelegate());
    this.startDelegate();
  }

  private delegateProcess: any = null;
  private isStopping = false;

  async startDelegate(): Promise<void> {
    if (this.delegateProcess) return;

    const rlmHome = process.env.RLM_HOME || join(process.env.HOME || "/", ".rlm");
    const delegateEntry = join(rlmHome, "agent", "workflows", "delegator.ts");
    
    // Check if delegator.ts exists, otherwise use the built-in entry
    const entryToUse = fs.existsSync(delegateEntry) ? delegateEntry : process.execPath;
    
    this.delegateProcess = exec(
      entryToUse,
      [
        "--mode=delegate",
        "--cwd=" + (process.cwd() || "."),
        "--print=false", // Don't show print interface for delegate
      ],
      {
        stdio: ["pipe", "pipe", "inherit"],
        detached: false,
        env: {
          ...process.env,
          RLM_EXECUTOR: "rlm-delegate",
          RLM_HOME: rlmHome,
          RLM_DELEGATE_CHILD: "1", // Mark as child process
        },
      }
    );
    
    this.delegateProcess.stdout.on('data', (data: any) => {
      if (!this.isStopping) {
        console.log('[iris-delegate]', data.toString().trim());
      }
    });
    
    this.delegateProcess.stderr.on('data', (data: any) => {
      if (!this.isStopping) {
        console.error('[iris-delegate]', data.toString().trim());
      }
    });
    
    this.delegateProcess.on('exit', (code: number, signal: string) => {
      if (!this.isStopping) {
        console.warn('[iris-delegate]', 'exited', code, signal);
        // Restart if it crashed
        setTimeout(() => this.startDelegate(), 1000);
      }
    });
    
    console.log('[iris-delegate]', 'started as child process');
  }

  async stopDelegate(): Promise<void> {
    this.isStopping = true;
    if (this.delegateProcess) {
      try {
        this.delegateProcess.kill('SIGTERM');
        await new Promise(resolve => setTimeout(resolve, 2000));
        if (this.delegateProcess.exitCode === null) {
          this.delegateProcess.kill('SIGKILL');
        }
      } catch (e) {}
      this.delegateProcess = null;
    }
  }

}

export default DelegateSpawner;
export const inject = [] as const;