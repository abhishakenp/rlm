/**
 * Fleet runs storage — persists run history for fleet members.
 *
 * Tracks per-task latest run, generation, conclusion, and age.
 * Stored at ~/.rlm/fleet-runs.json
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Conclusion of a task run. */
export type RunConclusion = "success" | "error" | "aborted" | "running";

/** A single task run record. */
export interface TaskRun {
	/** Unique run ID (UUID). */
	runId: string;
	/** Fleet member the run executed on. */
	host: string;
	/** Task name/label. */
	taskName: string;
	/** Generation number (iteration count for the same task). */
	generation: number;
	/** Run conclusion. */
	conclusion: RunConclusion;
	/** When the run started (timestamp). */
	startedAt: number;
	/** When the run ended (timestamp, 0 if still running). */
	endedAt: number;
	/** Duration in ms (endedAt - startedAt). */
	durationMs?: number;
	/** Error message if conclusion is "error" or "aborted". */
	error?: string;
}

/** Fleet runs configuration stored on disk. */
export interface FleetRunsConfig {
	/** Map of task names to their runs (most recent first). */
	runs: Record<string, TaskRun[]>;
}

const FLEET_RUNS_PATH = join(homedir(), ".rlm", "agent", "fleet-runs.json");

export async function loadFleetRunsConfig(): Promise<FleetRunsConfig> {
	try {
		const content = await readFile(FLEET_RUNS_PATH, "utf-8");
		return JSON.parse(content) as FleetRunsConfig;
	} catch {
		return { runs: {} };
	}
}

export async function saveFleetRunsConfig(config: FleetRunsConfig): Promise<void> {
	await mkdir(dirname(FLEET_RUNS_PATH), { recursive: true });
	await writeFile(FLEET_RUNS_PATH, `${JSON.stringify(config, null, 2)}
`, "utf-8");
}

/**
 * Record a new run for a task.
 */
export async function recordTaskRun(run: TaskRun): Promise<void> {
	const config = await loadFleetRunsConfig();
	const taskRuns = config.runs[run.taskName] ?? [];
	
	// Check if this is an update to a running task
	const existingIdx = taskRuns.findIndex(
		(r) => r.runId === run.runId && r.host === run.host && r.conclusion === "running",
	);
	
	if (existingIdx >= 0) {
		// Update existing running task
		taskRuns[existingIdx] = run;
	} else {
		// Add new run
		taskRuns.unshift(run);
	}
	
	// Keep only the last 100 runs per task
	config.runs[run.taskName] = taskRuns.slice(0, 100);
	await saveFleetRunsConfig(config);
}

/**
 * Update an existing run (e.g., when it completes).
 */
export async function updateTaskRun(runId: string, taskName: string, updates: Partial<TaskRun>): Promise<void> {
	const config = await loadFleetRunsConfig();
	const taskRuns = config.runs[taskName] ?? [];
	const idx = taskRuns.findIndex((r) => r.runId === runId);
	
	if (idx >= 0) {
		taskRuns[idx] = { ...taskRuns[idx], ...updates };
		config.runs[taskName] = taskRuns;
		await saveFleetRunsConfig(config);
	}
}

/**
 * Get the latest run for each task.
 */
export async function getLatestRuns(): Promise<Map<string, TaskRun>> {
	const config = await loadFleetRunsConfig();
	const latest = new Map<string, TaskRun>();
	
	for (const [taskName, runs] of Object.entries(config.runs)) {
		if (runs.length > 0) {
			// The runs array is ordered most recent first
			latest.set(taskName, runs[0]);
		}
	}
	
	return latest;
}

/**
 * Get runs for a specific host.
 */
export async function getRunsByHost(host: string): Promise<TaskRun[]> {
	const config = await loadFleetRunsConfig();
	const results: TaskRun[] = [];
	
	for (const runs of Object.values(config.runs)) {
		results.push(...runs.filter((r) => r.host === host));
	}
	
	return results.sort((a, b) => b.startedAt - a.startedAt);
}

/**
 * Get status summary for all tasks on a host.
 */
export async function getHostStatusSummary(
	host: string,
): Promise<{ totalRuns: number; running: number; completed: number; failed: number }> {
	const runs = await getRunsByHost(host);
	
	return {
		totalRuns: runs.length,
		running: runs.filter((r) => r.conclusion === "running").length,
		completed: runs.filter((r) => r.conclusion === "success").length,
		failed: runs.filter((r) => r.conclusion === "error" || r.conclusion === "aborted").length,
	};
}

/**
 * Get the fleet-wide status summary across all hosts.
 */
export async function getFleetStatusSummary(): Promise<
	Array<{
		host: string;
		totalRuns: number;
		running: number;
		completed: number;
		failed: number;
		latestRun?: TaskRun;
	}>
> {
	const config = await loadFleetRunsConfig();
	const hostMap = new Map<
		string,
		{ totalRuns: number; running: number; completed: number; failed: number; latestRun?: TaskRun }
	>();
	
	for (const runs of Object.values(config.runs)) {
		for (const run of runs) {
			const existing = hostMap.get(run.host) ?? { totalRuns: 0, running: 0, completed: 0, failed: 0 };
			existing.totalRuns++;
			if (run.conclusion === "running") existing.running++;
			else if (run.conclusion === "success") existing.completed++;
			else existing.failed++;
			
			// Keep the most recent run
			if (!existing.latestRun || run.startedAt > existing.latestRun.startedAt) {
				existing.latestRun = run;
			}
			
			hostMap.set(run.host, existing);
		}
	}
	
	return Array.from(hostMap.entries()).map(([host, stats]) => ({ host, ...stats }));
}
