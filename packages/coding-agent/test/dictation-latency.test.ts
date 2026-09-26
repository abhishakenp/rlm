import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import { EventStream } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { createTestResourceLoader } from "./utilities.js";

const MAX_LATENCY_MS = 2000;
const FAUX_STREAM_DELAY_MS = 0;

function makeAssistantMessage(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "faux-api",
    provider: "faux-provider",
    model: "faux-model",
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

class FauxEventStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
  constructor(private readonly text: string) {
    super(
      (event) => event.type === "done" || event.type === "error",
      (event) => {
        if (event.type === "done") return event.message;
        if (event.type === "error") return event.error;
        throw new Error("Unexpected event: " + JSON.stringify(event));
      },
    );
  }

  start() {
    this.push({ type: "start", partial: makeAssistantMessage("") });
    let index = 0;
    const emitNext = () => {
      if (index < this.text.length) {
        const delta = this.text[index++];
        const partial = makeAssistantMessage(this.text.slice(0, index));
        this.push({ type: "text_delta", contentIndex: 0, delta, partial });
        setTimeout(emitNext, FAUX_STREAM_DELAY_MS);
      } else {
        this.push({ type: "done", reason: "stop", message: makeAssistantMessage(this.text) });
      }
    };
    setTimeout(emitNext, FAUX_STREAM_DELAY_MS);
  }
}

describe("dictation latency", () => {
  it("time-to-first-output is under 2 seconds", async () => {
    const tempDir = join(tmpdir(), "pi-latency-test-" + Date.now());

    const agent = new Agent({
      getApiKey: () => "faux-key",
      initialState: {
        model: {
          id: "faux-model",
          name: "Faux Model",
          provider: "faux-provider",
          api: "faux-api" as any,
          input: 0,
          output: 0,
          contextWindow: 128000,
          maxTokens: 4096,
          reasoning: undefined,
          baseUrl: "http://localhost",
        },
        systemPrompt: "You are a test assistant.",
        tools: [],
      },
      streamFn: () => {
        const stream = new FauxEventStream("Hello");
        queueMicrotask(() => stream.start());
        return stream;
      },
      convertToLlm: (msgs) =>
        msgs.map((m) => ({
          role: m.role as "user" | "assistant" | "tool",
          content:
            typeof m.content === "string"
              ? m.content
              : (m.content as any[]).map((p) =>
                  p.type === "toolResult" ? { type: "tool_result" as const, ...p } : p,
                ),
        })) as any,
    });

    const sessionManager = SessionManager.inMemory();
    const settingsManager = SettingsManager.inMemory();
    const authStorage = AuthStorage.inMemory();
    const modelRegistry = ModelRegistry.inMemory(authStorage);
    authStorage.setRuntimeApiKey("faux-provider", "faux-key");

    const session = new AgentSession({
      agent,
      sessionManager,
      settingsManager,
      cwd: tempDir,
      modelRegistry,
      resourceLoader: createTestResourceLoader(),
    });

    let firstOutputTimestamp: number | undefined;
    session.subscribe((event) => {
      if (
        (event as any).type === "message_update" &&
        (event as any).assistantMessageEvent?.type === "text_delta"
      ) {
        if (firstOutputTimestamp === undefined) {
          firstOutputTimestamp = Date.now();
        }
      }
    });

    const submitTimestamp = Date.now();

    await session.prompt("Say hello");

    const elapsedMs =
      firstOutputTimestamp !== undefined ? firstOutputTimestamp - submitTimestamp : undefined;

    session.dispose();

    const message =
      elapsedMs !== undefined
        ? "measured time-to-first-output: " + elapsedMs + "ms (threshold: " + MAX_LATENCY_MS + "ms)"
        : "NO_OUTPUT: no message_update event was received";

    expect(elapsedMs, message).toBeLessThan(MAX_LATENCY_MS);
  });
});
