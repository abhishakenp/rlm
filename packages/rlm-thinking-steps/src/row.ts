/**
 * @rlm/thinking-steps — pi-thinking-steps (github.com/crustyhacker/pi-thinking-steps
 * v1.0.11, MIT) as an rlm row.
 *
 * Upstream is a pi extension: its session_start installs a render patch on
 * AssistantMessageComponent, and its commands, Alt+T and message events drive
 * the mode. In rlm that is not enough on its own:
 *
 * - A row mounted into an rlm that is already running (cordis.yml edited live)
 *   has no session_start coming, so the patch would never be installed there.
 * - In daemon mode the session — and so the extension — runs in a worker, while
 *   the TUI that renders runs in the client. A patch installed by the extension
 *   lands in the worker, where nothing is drawn.
 *
 * So the row installs the render patch itself, in whichever process mounts it,
 * the moment it mounts, and releases it when it is removed. It still contributes
 * the unchanged extension (commands, Alt+T, streaming state) through the shared
 * factory registry @rlm/agent drains, and asks live sessions to pick it up. A
 * mode chosen in one rlm process is carried to the others through a small state
 * file, so Alt+T in a daemon worker changes what the client draws.
 *
 * Everything else under ./ is upstream verbatim except the adaptations listed in
 * ../README.rlm.md.
 */
import { existsSync, mkdirSync, readFileSync, unwatchFile, watchFile, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import thinkingStepsExtension from "./index.ts";
import { retainThinkingStepsPatch } from "./internal-patch.ts";
import { parseThinkingMode } from "./parse.ts";
import { readThinkingStepsModePreference } from "./persistence.ts";
import { getCurrentThinkingScopeKey, onThinkingStepsModeChange, setThinkingStepsMode } from "./state.ts";
import type { ThinkingStepsMode } from "./types.ts";

export const name = "rlm-thinking-steps";

const ID = "rlm-thinking-steps";

type FactoryEntry = { id: string; factory: (pi: any) => void };

const registry = (): FactoryEntry[] => {
	const g = globalThis as { __rlmExtensionFactories?: FactoryEntry[] };
	if (!Array.isArray(g.__rlmExtensionFactories)) g.__rlmExtensionFactories = [];
	return g.__rlmExtensionFactories;
};

/** Where one rlm process tells the others which thinking view is showing. */
export const liveModeFile = (): string =>
	join(process.env.HOME?.trim() || homedir(), ".rlm", "agent", "state", "thinking-steps.live.json");

interface LiveMode {
	mode: ThinkingStepsMode;
	pid: number;
	at: number;
}

const readLive = (file: string): LiveMode | undefined => {
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<LiveMode>;
		const mode = parseThinkingMode(String(parsed.mode ?? ""));
		if (!mode || typeof parsed.pid !== "number" || typeof parsed.at !== "number") return undefined;
		return { mode, pid: parsed.pid, at: parsed.at };
	} catch {
		return undefined;
	}
};

export interface RowOptions {
	/** Poll interval for the cross-process mode file, ms. */
	syncIntervalMs?: number;
}

export function apply(ctx: any, config: RowOptions = {}) {
	const repaint = () => {
		try {
			ctx.get?.("rlmRenderer")?.instance?.ui?.requestRender?.();
		} catch {
			// No TUI in this process (print, headless, daemon worker): nothing to repaint.
		}
	};

	// 1. The extension, for every session this process creates from now on.
	ctx.effect(() => {
		const reg = registry();
		// A hot swap registers the new generation in place of the old one.
		const stale = reg.findIndex((e) => e.id === ID);
		if (stale >= 0) reg.splice(stale, 1);
		const entry: FactoryEntry = { id: ID, factory: thinkingStepsExtension };
		reg.push(entry);
		// Sessions already running pick new extensions up when their resources
		// reload (the same event rlm-hmr sends when an extension file changes).
		try {
			ctx.emit?.("rlm/resources-changed", { paths: [], reason: "thinking-steps row mounted" });
		} catch {
			// No live session listening: the next one reads the registry itself.
		}
		return () => {
			const at = registry().indexOf(entry);
			if (at >= 0) registry().splice(at, 1);
			try {
				ctx.emit?.("rlm/resources-changed", { paths: [], reason: "thinking-steps row removed" });
			} catch {
				// Nothing listening.
			}
		};
	});

	// 2. The render patch, in this process, now.
	ctx.effect(() => {
		let release: (() => Promise<void>) | undefined;
		let disposed = false;
		void (async () => {
			try {
				// Where no extension runs here (a daemon client), start from the
				// saved default the extension would have restored: project, then global.
				const cwd = process.cwd();
				const saved =
					(await readThinkingStepsModePreference("project", cwd).catch(() => undefined)) ??
					(await readThinkingStepsModePreference("global", cwd).catch(() => undefined));
				if (saved) setThinkingStepsMode(saved, getCurrentThinkingScopeKey());
				const r = await retainThinkingStepsPatch();
				if (disposed) {
					await r();
					return;
				}
				release = r;
				repaint();
			} catch (error) {
				ctx.logger?.warn?.(`thinking-steps: render patch not installed: ${(error as Error)?.message ?? error}`);
			}
		})();
		return () => {
			disposed = true;
			const r = release;
			release = undefined;
			void r?.().then(repaint, () => {});
		};
	});

	// 3. One view across processes: publish local changes, adopt others'.
	ctx.effect(() => {
		const file = liveModeFile();
		let applying = false;
		let lastSeen = readLive(file)?.at ?? 0;
		const off = onThinkingStepsModeChange((mode) => {
			if (applying) return;
			try {
				mkdirSync(dirname(file), { recursive: true });
				const at = Date.now();
				lastSeen = at;
				writeFileSync(file, `${JSON.stringify({ mode, pid: process.pid, at })}\n`);
			} catch {
				// Best effort: the local view already changed.
			}
		});
		const onFile = () => {
			const live = readLive(file);
			if (!live || live.pid === process.pid || live.at <= lastSeen) return;
			lastSeen = live.at;
			applying = true;
			try {
				setThinkingStepsMode(live.mode, getCurrentThinkingScopeKey());
			} finally {
				applying = false;
			}
			repaint();
		};
		if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true });
		watchFile(file, { interval: config.syncIntervalMs ?? 500 }, onFile);
		return () => {
			off();
			unwatchFile(file, onFile);
		};
	});
}
