/**
 * @rlm/kernel — IPython/ZMQ kernel service.
 *
 * Clean Cordis Service. No prime-agent code.
 * Manages an IPython kernel subprocess via ZMQ (Jupyter comm protocol).
 *
 * Reference: DSH's dsh-code-runtime manages code execution. Prime-agent's
 * kernel uses ZMQ dealer/subscriber sockets with Jupyter protocol 5.3.
 * rlm-kernel implements the same protocol from scratch.
 *
 * On disposal (HMR): shuts down kernel process, closes ZMQ sockets.
 */
import { Service } from "@deepseek-ai/cordis";
import { spawn, type ChildProcess } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";

export interface RlmKernelConfig {
	pythonPath?: string;
	kernelDir?: string;
}

interface KernelConnection {
	shellPort: number;
	iopubPort: number;
	stdinPort: number;
	controlPort: number;
	hbPort: number;
	transport: "tcp";
	ip: string;
	signatureScheme: string;
	key: string;
}

export class RlmKernelService extends Service {
	static inject = [] as const;
	static provide = "rlmKernel" as const;

	declare config: RlmKernelConfig;
	private process: ChildProcess | null = null;
	private connection: KernelConnection | null = null;
	private connectionFile: string | null = null;
	private zmq: any = null;
	private shellSocket: any = null;
	private iopubSocket: any = null;
	private hbSocket: any = null;
	private sessionKey: string = "";
	private messageCount = 0;

	constructor(ctx: any, config: RlmKernelConfig = {}) {
		super(ctx, "rlmKernel");
		this.config = config;
	}

	async [Service.init]() {
		try {
			this.zmq = await import("zeromq");
		} catch {
			this.ctx.logger?.warn("rlm-kernel: zeromq not available — kernel disabled");
			return;
		}
		this.ctx.logger?.info("rlm-kernel: ZMQ kernel service ready (lazy init)");
	}

	/** Start the IPython kernel. */
	async start(): Promise<void> {
		if (this.process) return;

		const kernelDir = this.config.kernelDir ?? join(homedir(), ".rlm", "kernel-venv");
		const pythonPath = this.config.pythonPath ?? "python3";

		// Generate connection info with random ports.
		const key = randomUUID().replace(/-/g, "");
		this.connection = {
			shellPort: 0,
			iopubPort: 0,
			stdinPort: 0,
			controlPort: 0,
			hbPort: 0,
			transport: "tcp",
			ip: "127.0.0.1",
			signatureScheme: "hmac-sha256",
			key,
		};

		// Write connection file (IPython reads this).
		const connDir = join(homedir(), ".rlm", "kernel-connections");
		if (!existsSync(connDir)) mkdirSync(connDir, { recursive: true });
		this.connectionFile = join(connDir, `kernel-${Date.now()}.json`);
		writeFileSync(this.connectionFile, JSON.stringify(this.connection), "utf-8");

		// Spawn IPython kernel.
		this.process = spawn(pythonPath, [
			"-m", "ipykernel_launcher",
			"-f", this.connectionFile,
		], {
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env },
		});

		this.process.stdout?.on("data", (data) => {
			this.ctx.logger?.debug(`rlm-kernel: stdout: ${data.toString().trim()}`);
		});
		this.process.stderr?.on("data", (data) => {
			this.ctx.logger?.debug(`rlm-kernel: stderr: ${data.toString().trim()}`);
		});
		this.process.on("exit", (code) => {
			this.ctx.logger?.info(`rlm-kernel: process exited (code=${code})`);
			this.process = null;
		});

		// Wait for kernel to write ports to connection file.
		await this.waitForKernelReady();

		// Connect ZMQ sockets.
		await this.connectSockets();

		this.ctx.logger?.info("rlm-kernel: IPython kernel started");
	}

	/** Wait for the kernel to update the connection file with actual ports. */
	private async waitForKernelReady(): Promise<void> {
		if (!this.connectionFile) return;
		for (let i = 0; i < 50; i++) {
			await new Promise((r) => setTimeout(r, 100));
			try {
				const content = readFileSync(this.connectionFile, "utf-8");
				const conn = JSON.parse(content);
				if (conn.shell_port && conn.shell_port > 0) {
					this.connection = {
						shellPort: conn.shell_port,
						iopubPort: conn.iopub_port,
						stdinPort: conn.stdin_port,
						controlPort: conn.control_port,
						hbPort: conn.hb_port,
						transport: conn.transport ?? "tcp",
						ip: conn.ip ?? "127.0.0.1",
						signatureScheme: conn.signature_scheme ?? "hmac-sha256",
						key: conn.key ?? this.connection?.key ?? "",
					};
					this.sessionKey = this.connection.key;
					return;
				}
			} catch {
				// File not ready yet.
			}
		}
		throw new Error("rlm-kernel: kernel failed to start (connection file timeout)");
	}

	/** Connect ZMQ sockets to the kernel. */
	private async connectSockets(): Promise<void> {
		if (!this.zmq || !this.connection) return;

		const { Dealer, Subscriber, Pair } = this.zmq;

		// Shell socket (DEALER) — send execute requests.
		this.shellSocket = new Dealer();
		await this.shellSocket.connect(`tcp://${this.connection.ip}:${this.connection.shellPort}`);

		// IOPub socket (SUB) — receive output.
		this.iopubSocket = new Subscriber();
		await this.iopubSocket.connect(`tcp://${this.connection.ip}:${this.connection.iopubPort}`);
		await this.iopubSocket.subscribe("");

		// Heartbeat socket (REQ) — liveness check.
		this.hbSocket = new Pair();
		await this.hbSocket.connect(`tcp://${this.connection.ip}:${this.connection.hbPort}`);

		this.ctx.logger?.info("rlm-kernel: ZMQ sockets connected");
	}

	/** Execute code in the kernel. Returns the output. */
	async execute(code: string, timeoutMs = 30000): Promise<string> {
		if (!this.shellSocket || !this.iopubSocket) {
			await this.start();
		}
		if (!this.shellSocket || !this.iopubSocket) {
			throw new Error("rlm-kernel: failed to start kernel");
		}

		const msgId = `rlm-${Date.now()}-${this.messageCount++}`;
		const session = `rlm-session-${Date.now()}`;

		// Build Jupyter execute_request message.
		const message = this.buildMessage("execute_request", session, {
			code,
			silent: false,
			store_history: true,
			user_expressions: {},
			allow_stdin: false,
			stop_on_error: true,
		}, msgId);

		await this.sendMessage(this.shellSocket, message);

		// Collect output until idle status.
		let output = "";
		const deadline = Date.now() + timeoutMs;

		while (Date.now() < deadline) {
			const received = await this.receiveMessage(this.iopubSocket, 5000);
			if (!received) continue;

			const msgType = received.header?.msg_type;
			const content = received.content ?? {};

			if (msgType === "stream") {
				output += content.text ?? "";
			} else if (msgType === "execute_result") {
				output += content.data?.["text/plain"] ?? "";
			} else if (msgType === "error") {
				output += (content.traceback ?? []).join("\n");
			} else if (msgType === "status" && content.execution_state === "idle") {
				break;
			}
		}

		return output;
	}

	/** Build a Jupyter protocol message. */
	private buildMessage(msgType: string, session: string, content: any, msgId?: string) {
		return {
			header: {
				msg_id: msgId ?? `rlm-${Date.now()}-${this.messageCount++}`,
				msg_type: msgType,
				version: "5.3",
				date: new Date().toISOString(),
				session,
				username: "rlm",
			},
			parent_header: {},
			metadata: {},
			content,
		};
	}

	/** Send a message over a ZMQ socket (Jupyter wire protocol). */
	private async sendMessage(socket: any, message: any): Promise<void> {
		const delimiter = "<IDS|MSG>";
		const payload = JSON.stringify(message.header) + JSON.stringify(message.parent_header) +
			JSON.stringify(message.metadata) + JSON.stringify(message.content);
		await socket.send([delimiter, payload]);
	}

	/** Receive a message from a ZMQ socket (Jupyter wire protocol). */
	private async receiveMessage(socket: any, timeoutMs = 5000): Promise<any> {
		try {
			const result = await Promise.race([
				socket.receive(),
				new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs)),
			]);
			const parts = Array.isArray(result) ? result : [result];
			// Find the delimiter, then parse the 4 JSON parts after it.
			let delimiterIdx = -1;
			for (let i = 0; i < parts.length; i++) {
				if (parts[i].toString() === "<IDS|MSG>") {
					delimiterIdx = i;
					break;
				}
			}
			if (delimiterIdx === -1 || delimiterIdx + 4 >= parts.length) return null;
			return {
				header: JSON.parse(parts[delimiterIdx + 1].toString()),
				parent_header: JSON.parse(parts[delimiterIdx + 2].toString()),
				metadata: JSON.parse(parts[delimiterIdx + 3].toString()),
				content: JSON.parse(parts[delimiterIdx + 4].toString()),
			};
		} catch {
			return null;
		}
	}

	/** Check if kernel is running. */
	get isRunning(): boolean {
		return this.process !== null && this.process.exitCode === null;
	}

	/** Shutdown the kernel. */
	async shutdown(): Promise<void> {
		if (this.shellSocket) {
			try {
				const message = this.buildMessage("shutdown_request", "rlm-shutdown", { restart: false });
				await this.sendMessage(this.shellSocket, message);
			} catch {
				// Best effort.
			}
		}
		if (this.process) {
			this.process.kill("SIGTERM");
			this.process = null;
		}
		if (this.shellSocket) { try { this.shellSocket.close(); } catch {} this.shellSocket = null; }
		if (this.iopubSocket) { try { this.iopubSocket.close(); } catch {} this.iopubSocket = null; }
		if (this.hbSocket) { try { this.hbSocket.close(); } catch {} this.hbSocket = null; }
		if (this.connectionFile) { try { unlinkSync(this.connectionFile); } catch {} this.connectionFile = null; }
	}

	async [Symbol.dispose]() {
		await this.shutdown();
	}
}

export default RlmKernelService;
export const name = "rlm-kernel";
export const inject = [] as const;
export { RlmKernelService as RlmKernel };
