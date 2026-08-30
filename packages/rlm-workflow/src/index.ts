/**
 * @rlm/workflow — hot-swappable TS workflow orchestrator.
 *
 * Cordis Service. Loads workflow definitions from ~/.rlm/workflows/*.ts,
 * hot-reloads them on file change, and exposes them via ctx.get("rlmWorkflow").
 *
 * Workflows use @rlm/sdk to compose recursive agent trees:
 *   - spawn subagents (rlm.run)
 *   - manage goals (rlm.goal)
 *   - coordinate plan → exec → review → test loops
 *   - branch based on subagent results
 *
 * A workflow is a TS module that exports a default function:
 *   export default define((api) => ({
 *     name: "delegator",
 *     async run(input: string) {
 *       const plan = await api.sdk.spawn("Decompose: " + input, { name: "planner" });
 *       // ... spawn executors, reviewers, etc.
 *       return result;
 *     }
 *   }));
 *
 * Hot-swap: editing a workflow file triggers chokidar → dispose old → re-import.
 * The new workflow is active immediately — no restart.
 *
 * Reference: Cordis HMR philosophy — plugins are disposable, reloadable fibers.
 * This applies the same principle to workflow definitions.
 */
import { Service } from "@deepseek-ai/cordis";
import { watch } from "chokidar";
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";

export interface RlmWorkflowConfig {
	workflowsDir?: string;
}

export interface WorkflowApi {
	sdk: any;
	ctx: any;
	emit: (event: string, data: any) => void;
}

export interface Workflow {
	name: string;
	run: (input: string, api: WorkflowApi) => Promise<string>;
}

export interface WorkflowDef {
	name: string;
	run: (input: string, api: WorkflowApi) => Promise<string>;
}

/** define() — workflow definition helper. */
export function define(fn: (api: WorkflowApi) => WorkflowDef): (api: WorkflowApi) => Workflow {
	return (api: WorkflowApi) => {
		const def = fn(api);
		return {
			name: def.name,
			run: def.run,
		};
	};
}

export class RlmWorkflowService extends Service {
	static inject = [] as const;
	static provide = "rlmWorkflow" as const;

	declare config: RlmWorkflowConfig;
	private workflows: Map<string, Workflow> = new Map();
	private workflowFactories: Map<string, (api: WorkflowApi) => Workflow> = new Map();
	private watcher: any = null;

	constructor(ctx: any, config: RlmWorkflowConfig = {}) {
		super(ctx, undefined as any);
		this.config = typeof config === "object" && !Array.isArray(config) ? config : {};
	}

	async [Service.init]() {
		const dir = this.getWorkflowsDir();
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
			this.ctx.logger?.info(`rlm-workflow: created workflows dir ${dir}`);
		}

		await this.loadAllWorkflows();
		this.startWatcher();

		this.ctx.logger?.info(
			`rlm-workflow: ${this.workflows.size} workflow(s) loaded from ${dir}`,
		);
	}

	private getWorkflowsDir(): string {
		return this.config.workflowsDir ?? join(homedir(), ".rlm", "workflows");
	}

	private getApi(): WorkflowApi {
		const sdk = this.ctx.get("rlmSdk");
		return {
			sdk,
			ctx: this.ctx,
			emit: (event: string, data: any) => this.ctx.emit(event, data),
		};
	}

	/** Load all .ts/.js workflow files from the workflows directory. */
	private async loadAllWorkflows() {
		const dir = this.getWorkflowsDir();
		if (!existsSync(dir)) return;

		const files = readdirSync(dir).filter(
			(f) => f.endsWith(".ts") || f.endsWith(".js") || f.endsWith(".mjs"),
		);

		for (const file of files) {
			await this.loadWorkflow(join(dir, file));
		}
	}

	/** Load (or reload) a single workflow file. */
	private async loadWorkflow(filePath: string) {
		const name = filePath.split("/").pop()!.replace(/\.(ts|js|mjs)$/, "");
		try {
			// Cache-bust for HMR — append timestamp query param.
			const url = `${pathToFileURL(filePath).href}?t=${Date.now()}`;

			// Inject `define` as a global so workflow files don't need imports.
			// This makes workflows self-contained — they just use `define()`.
			const mod = await import(url);

			// The workflow file can either:
			// 1. Export default = define(fn) — standard pattern
			// 2. Export default = fn — raw factory function
			// 3. Use globalThis.define(fn) and export default = result
			const factory = mod.default;

			if (typeof factory !== "function") {
				this.ctx.logger?.warn(`rlm-workflow: ${name} has no default export function`);
				return;
			}

			// Dispose old workflow if exists.
			this.workflows.delete(name);
			this.workflowFactories.delete(name);

			// Register the factory and instantiate the workflow.
			this.workflowFactories.set(name, factory);
			const api = this.getApi();
			const workflow = factory(api);
			this.workflows.set(name, workflow);

			this.ctx.logger?.info(`rlm-workflow: loaded "${name}"`);
			this.ctx.emit("rlm/workflow-loaded", { name, path: filePath });
		} catch (error) {
			this.ctx.logger?.warn(
				`rlm-workflow: failed to load ${name}: ${error instanceof Error ? error.message : error}`,
			);
		}
	}

	/** Start chokidar watcher for hot-reload. */
	private startWatcher() {
		const dir = this.getWorkflowsDir();
		if (!existsSync(dir)) return;

		this.watcher = watch(dir, {
			ignoreInitial: true,
			ignored: ["**/node_modules", "**/.*"],
		});

		this.watcher.on("change", (path: string) => {
			if (path.endsWith(".ts") || path.endsWith(".js") || path.endsWith(".mjs")) {
				this.ctx.logger?.info(`rlm-workflow: HMR — ${path} changed, reloading...`);
				this.loadWorkflow(path);
			}
		});

		this.watcher.on("add", (path: string) => {
			if (path.endsWith(".ts") || path.endsWith(".js") || path.endsWith(".mjs")) {
				this.ctx.logger?.info(`rlm-workflow: new workflow ${path}, loading...`);
				this.loadWorkflow(path);
			}
		});

		this.watcher.on("unlink", (path: string) => {
			const name = path.split("/").pop()!.replace(/\.(ts|js|mjs)$/, "");
			this.workflows.delete(name);
			this.workflowFactories.delete(name);
			this.ctx.logger?.info(`rlm-workflow: removed "${name}"`);
			this.ctx.emit("rlm/workflow-removed", { name, path });
		});
	}

	/** Get a workflow by name. */
	getWorkflow(name: string): Workflow | undefined {
		return this.workflows.get(name);
	}

	/** List all loaded workflows. */
	listWorkflows(): string[] {
		return [...this.workflows.keys()];
	}

	/** Run a workflow by name with the given input. */
	async run(name: string, input: string): Promise<string> {
		const workflow = this.workflows.get(name);
		if (!workflow) {
			throw new Error(`rlm-workflow: workflow "${name}" not found. Available: ${this.listWorkflows().join(", ")}`);
		}

		const api = this.getApi();
		this.ctx.emit("rlm/workflow-start", { name, input });
		const started = Date.now();

		try {
			const result = await workflow.run(input, api);
			this.ctx.emit("rlm/workflow-complete", { name, result, durationMs: Date.now() - started });
			return result;
		} catch (error) {
			this.ctx.emit("rlm/workflow-error", { name, error: error instanceof Error ? error.message : String(error) });
			throw error;
		}
	}

	/** Reload a specific workflow (manual trigger). */
	async reload(name: string) {
		const dir = this.getWorkflowsDir();
		for (const ext of [".ts", ".js", ".mjs"]) {
			const path = join(dir, name + ext);
			if (existsSync(path)) {
				await this.loadWorkflow(path);
				return;
			}
		}
		throw new Error(`rlm-workflow: workflow file "${name}" not found in ${dir}`);
	}

	async [Symbol.dispose]() {
		if (this.watcher) {
			await this.watcher.close();
			this.watcher = null;
		}
		this.workflows.clear();
		this.workflowFactories.clear();
	}
}

export default RlmWorkflowService;
export const name = "rlm-workflow";
export const inject = [] as const;
export { RlmWorkflowService as RlmWorkflow };
