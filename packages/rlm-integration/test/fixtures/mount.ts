// Mounts rlm-integration on PORT in its own process; exits after LIFE_MS.
// `--mode daemon` in argv makes the row treat this process as the supervisor.
import { Context, Service } from "@deepseek-ai/cordis";
import RlmIntegration from "../../src/index.ts";
class FakeConfig extends Service {
	static provide = "rlmConfig" as const;
	constructor(ctx: any) {
		super(ctx, undefined as any);
	}
	get() {
		return {};
	}
}
const root = new Context();
root.plugin(FakeConfig);
root.plugin(RlmIntegration as any, { port: Number(process.env.PORT), host: "127.0.0.1" });
for (let i = 0; i < 500; i++) {
	const svc = root.get("rlmIntegration") as any;
	if (svc?.status && (svc.status.running || i > 100)) {
		console.log(JSON.stringify({ running: svc.status.running }));
		break;
	}
	await Bun.sleep(10);
}
setTimeout(() => process.exit(0), Number(process.env.LIFE_MS ?? 60_000));
