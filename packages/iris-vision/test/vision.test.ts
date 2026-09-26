/**
 * iris-vision per-context frame state: capture marks it active with the new
 * frame, keeps the interval unless given one, stop keeps the last frame, clear
 * forgets it; provide() hands out iris.vision. Run: `bun test packages/iris-vision`.
 */
import { expect, test } from "bun:test";
import IrisVision, { captureVision, clearVision, getVisionState, stopVision } from "../src/index.ts";

test("capture → state → stop → clear", () => {
	const ctx = "vision-test";
	clearVision(ctx);
	expect(getVisionState(ctx)).toBeNull();

	const f1 = captureVision(ctx, 640, 480, "AAAA", { source: "screen", intervalMs: 250 });
	expect(f1).toMatchObject({ width: 640, height: 480, data: "AAAA", source: "screen" });
	expect(getVisionState(ctx)).toMatchObject({ active: true, frameId: f1.id, intervalMs: 250 });

	const f2 = captureVision(ctx, 10, 10, "BB");
	expect(f2.id).not.toBe(f1.id);
	expect(getVisionState(ctx)).toMatchObject({ active: true, frameId: f2.id, intervalMs: 250 });

	stopVision(ctx);
	expect(getVisionState(ctx)).toMatchObject({ active: false, frameId: f2.id });

	clearVision(ctx);
	expect(getVisionState(ctx)).toBeNull();
	stopVision(ctx);
	expect(getVisionState(ctx)).toBeNull();
});

test("provide() hands out iris.vision", () => {
	const v = IrisVision.provide().iris.vision;
	expect(Object.keys(v).sort()).toEqual(["capture", "clear", "state", "stop"]);
});
