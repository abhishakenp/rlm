/**
 * @rlm/cliproxy — Claude, Codex, Gemini … subscriptions as rlm models.
 *
 * CLIProxyAPI (github.com/router-for-me/CLIProxyAPI) logs into those
 * subscriptions with their own OAuth flows and serves them on one local port,
 * as OpenAI, Claude and Responses APIs. This row makes whatever it currently
 * serves appear in rlm as the `cliproxy` provider — in the model picker, for
 * `--model cliproxy/<id>`, and for delegation — with no restart when the set
 * changes.
 *
 * ## How the models get in
 *
 * - The row polls `GET /v1/models` (on init, then every `refreshMs`). What
 *   CLIProxyAPI lists is exactly what can be called right now: a login added
 *   with `cliproxyapi -claude-login` shows up on the next poll, and a
 *   credential cooling down on a quota drops out until it recovers.
 * - Each session gets an extension factory (the same `__rlmExtensionFactories`
 *   channel rlm-pixel and rlm-guard use) that calls `pi.registerProvider`.
 *   Registration is live: a changed listing is re-registered on every open
 *   session, and the picker, which re-reads the registry when opened, shows it.
 * - The last good listing is kept in `~/.rlm/agent/cliproxy-models.json`, so a
 *   session that starts before the first poll answers — or while CLIProxyAPI is
 *   restarting — still has the models it had a minute ago.
 *
 * What each id maps to (wire format, context window) is `catalog.ts`.
 *
 * ## Auth
 *
 * The key is CLIProxyAPI's own client key (`api-keys` in its config), read from
 * `apiKeyFile` (default `~/.cli-proxy-api/rlm-api-key`). No provider key ever
 * passes through rlm: the subscriptions' OAuth tokens stay in CLIProxyAPI's
 * auth dir.
 */
import { Service } from "@deepseek-ai/cordis";
import { getModels, getProviders } from "@earendil-works/pi-ai";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
	buildProviderConfig,
	type CliproxyProviderConfig,
	type KnownModel,
	rootOf,
	sameModels,
} from "./catalog.ts";

export const PLUGIN_ID = "rlm-cliproxy";
export const PROVIDER = "cliproxy";

export interface RlmCliproxyConfig {
	/** CLIProxyAPI's address. Default http://127.0.0.1:8317. */
	baseUrl?: string;
	/** Client key inline. Prefer `apiKeyFile`. */
	apiKey?: string;
	/** File holding the client key. Default ~/.cli-proxy-api/rlm-api-key. */
	apiKeyFile?: string;
	/** Poll interval. Default 60s. */
	refreshMs?: number;
	/** Where the last good listing is kept. Default ~/.rlm/agent/cliproxy-models.json. */
	cacheFile?: string;
}

type FactoryEntry = { id: string; factory: (pi: any) => void };

const factoryRegistry = (): FactoryEntry[] => {
	const g = globalThis as any;
	if (!Array.isArray(g.__rlmExtensionFactories)) g.__rlmExtensionFactories = [];
	return g.__rlmExtensionFactories as FactoryEntry[];
};

const expand = (p: string): string => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

/** Built-in metadata for an id, from whichever built-in provider lists it. */
const catalogLookup = (): ((id: string) => KnownModel | undefined) => {
	const byId = new Map<string, KnownModel>();
	try {
		// Subscription providers first: their entries describe the model as the
		// subscription serves it (e.g. Codex's 272k window, not the API's).
		const order = ["openai-codex", "anthropic", "openai", "google", ...getProviders()];
		for (const provider of new Set(order)) {
			for (const m of getModels(provider as any) as any[]) if (!byId.has(m.id)) byId.set(m.id, m);
		}
	} catch {}
	return (id) => byId.get(id);
};

export class RlmCliproxyService extends Service {
	static inject = [] as const;
	static provide = "rlmCliproxy" as const;

	declare config: RlmCliproxyConfig;

	private provider: CliproxyProviderConfig | undefined;
	/** Every live session's extension API, so a changed listing reaches them all. */
	private sessions = new Set<any>();
	private lastError: string | undefined;
	private lookup = catalogLookup();

	constructor(ctx: any, config: RlmCliproxyConfig = {}) {
		super(ctx, undefined as any);
		this.config = config;
	}

	private get baseUrl() {
		return rootOf(this.config.baseUrl ?? "http://127.0.0.1:8317");
	}

	private get cacheFile() {
		return expand(this.config.cacheFile ?? "~/.rlm/agent/cliproxy-models.json");
	}

	private apiKey(): string | undefined {
		if (this.config.apiKey) return this.config.apiKey;
		try {
			return readFileSync(expand(this.config.apiKeyFile ?? "~/.cli-proxy-api/rlm-api-key"), "utf8").trim() || undefined;
		} catch {
			return undefined;
		}
	}

	async [Service.init]() {
		this.loadCache();
		this.contributeFactory();
		await this.refresh();
		const timer = setInterval(() => void this.refresh(), this.config.refreshMs ?? 60_000);
		timer.unref?.();
		this.ctx.effect(() => () => clearInterval(timer));
	}

	/** What rlm currently offers from CLIProxyAPI, and why not more. */
	status() {
		return {
			baseUrl: this.baseUrl,
			models: this.provider?.models.map((m) => `${PROVIDER}/${m.id}`) ?? [],
			sessions: this.sessions.size,
			error: this.lastError,
		};
	}

	/** Poll CLIProxyAPI once. Resolves to the model ids now registered. */
	async refresh(): Promise<string[]> {
		const apiKey = this.apiKey();
		if (!apiKey) {
			this.lastError = "no CLIProxyAPI client key (set apiKey or write ~/.cli-proxy-api/rlm-api-key)";
			return this.status().models;
		}
		try {
			const res = await fetch(`${this.baseUrl}/v1/models`, {
				headers: { Authorization: `Bearer ${apiKey}` },
				signal: AbortSignal.timeout(5_000),
			});
			if (!res.ok) throw new Error(`GET /v1/models → HTTP ${res.status}`);
			const body = (await res.json()) as { data?: { id?: unknown }[] };
			const ids = (body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string");
			this.lastError = undefined;
			this.apply(buildProviderConfig(ids, { baseUrl: this.baseUrl, apiKey, lookup: this.lookup }));
		} catch (error) {
			// Unreachable is not "no models": keep what was last listed, so a
			// CLIProxyAPI restart does not empty the picker mid-session.
			this.lastError = error instanceof Error ? error.message : String(error);
		}
		return this.status().models;
	}

	private apply(next: CliproxyProviderConfig) {
		const changed = !this.provider || !sameModels(this.provider.models, next.models) || this.provider.apiKey !== next.apiKey;
		this.provider = next;
		if (!changed) return;
		this.saveCache(next);
		for (const pi of [...this.sessions]) this.register(pi);
		this.ctx.logger?.info?.(`rlm-cliproxy: ${next.models.length} model(s): ${next.models.map((m) => m.id).join(", ") || "(none)"}`);
	}

	private register(pi: any) {
		const provider = this.provider;
		try {
			if (provider && provider.models.length > 0) pi.registerProvider(PROVIDER, provider);
			else pi.unregisterProvider?.(PROVIDER);
		} catch {
			// A session that has shut down throws on use; stop telling it things.
			this.sessions.delete(pi);
		}
	}

	private contributeFactory() {
		this.ctx.effect(() => {
			const reg = factoryRegistry();
			const stale = reg.findIndex((e) => e.id === PLUGIN_ID);
			if (stale >= 0) reg.splice(stale, 1);
			const entry: FactoryEntry = {
				id: PLUGIN_ID,
				factory: (pi: any) => {
					this.sessions.add(pi);
					pi.on?.("session_shutdown", () => this.sessions.delete(pi));
					this.register(pi);
				},
			};
			reg.push(entry);
			return () => {
				const i = reg.indexOf(entry);
				if (i >= 0) reg.splice(i, 1);
				// A swapped-out fiber hands its sessions to nobody; the new
				// fiber's factory re-registers them on their next reload.
				this.sessions.clear();
			};
		});
	}

	private loadCache() {
		try {
			if (!existsSync(this.cacheFile)) return;
			const cached = JSON.parse(readFileSync(this.cacheFile, "utf8")) as CliproxyProviderConfig;
			const apiKey = this.apiKey();
			if (Array.isArray(cached?.models) && apiKey) this.provider = { ...cached, apiKey };
		} catch {}
	}

	private saveCache(provider: CliproxyProviderConfig) {
		try {
			mkdirSync(dirname(this.cacheFile), { recursive: true });
			const tmp = `${this.cacheFile}.tmp`;
			// The key lives in its own 0600 file; the cache never carries it.
			writeFileSync(tmp, `${JSON.stringify({ ...provider, apiKey: "" }, null, "\t")}\n`, { mode: 0o600 });
			renameSync(tmp, this.cacheFile);
		} catch {}
	}
}

export default RlmCliproxyService;
