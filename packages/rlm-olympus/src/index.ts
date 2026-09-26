/**
 * @rlm/olympus — `rlm olympus <stage>` as a row.
 *
 * Registers one mode with `rlmModes`; everything it does is in `./cli.ts`, which
 * `bin/olympus.mjs` also runs without rlm. Re-registers whenever `rlmModes` is
 * provided again (a hot swap of that row), and unregisters through `ctx.effect`,
 * the only disposer Cordis 4.0.2 calls.
 */
import { Service } from "@deepseek-ai/cordis";
import { runOlympus } from "./cli.ts";

export const name = "rlm-olympus";

export class RlmOlympusService extends Service {
	static inject = [] as const;
	static provide = "rlmOlympus" as const;
	private registration: { dispose: () => void } | undefined;

	constructor(ctx: any, config: unknown = {}) {
		super(ctx, undefined as any);
		void config;
	}

	[Service.init]() {
		this.attach();
		const off = (this.ctx as any).on?.("internal/service", (key: string) => {
			if (key === "rlmModes") this.attach(true);
		});
		(this.ctx as any).effect(() => () => {
			try {
				if (typeof off === "function") off();
			} catch {}
			this.detach();
		});
	}

	private attach(again = false) {
		const modes = (this.ctx as any).get?.("rlmModes") as
			| { register(mode: unknown): { dispose: () => void } }
			| undefined;
		if (!modes?.register) return;
		if (again) this.detach();
		if (this.registration) return;
		this.registration = modes.register({
			id: "olympus",
			// Above `print`, which claims any invocation with nothing on a TTY.
			priority: 64,
			claims: (argv: string[]) => argv[0] === "olympus",
			run: (argv: string[]) => runOlympus(argv.slice(1)),
		});
	}

	private detach() {
		try {
			this.registration?.dispose();
		} catch {}
		this.registration = undefined;
	}
}

export default RlmOlympusService;
