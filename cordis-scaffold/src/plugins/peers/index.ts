import { Service } from "@deepseek-ai/cordis";
import { randomUUID } from "node:crypto";

export interface PeersConfig {
  discovery: "tailscale" | "multicast" | "manual";
  peers?: string[];
}

interface PeerMessage {
  id: string;
  from: string;
  to: string;
  type: string;
  data: unknown;
  timestamp: number;
}

export class PeersService extends Service {
  static inject = ["memory"] as const;

  private config: PeersConfig;
  private peers: Set<string> = new Set();
  private messages: PeerMessage[] = [];
  private selfId: string;

  constructor(ctx: any, config: PeersConfig) {
    super(ctx, "peers");
    this.config = config;
    this.selfId = `rlm-${randomUUID().slice(0, 8)}`;
  }

  async *[Service.init]() {
    if (this.config.peers) for (const p of this.config.peers) this.peers.add(p);
    this.ctx.on("refine/complete", (e: { proposal: { id: string } }) =>
      this.broadcast({ type: "refine-sync", data: e }),
    );
    this.ctx.on("wound/detected", (d: { pluginId: string }) =>
      this.broadcast({ type: "wound-alert", data: d }),
    );
    this.ctx.logger.info(
      `peers: mesh ready (id=${this.selfId}, discovery=${this.config.discovery}, peers=${this.peers.size})`,
    );

    yield async () => {};
  }

  async discover(): Promise<string[]> { return Array.from(this.peers); }

  async send(msg: { to: string; type: string; data: unknown }): Promise<boolean> {
    const m: PeerMessage = { id: randomUUID(), from: this.selfId, to: msg.to, type: msg.type, data: msg.data, timestamp: Date.now() };
    this.messages.push(m);
    this.ctx.emit("peer/message-sent", m);
    return true;
  }

  async broadcast(msg: { type: string; data: unknown }): Promise<void> {
    for (const p of this.peers) await this.send({ to: p, type: msg.type, data: msg.data });
  }

  async sync(kind: "memory" | "refinement" | "wound"): Promise<void> {
    const mem = this.ctx.memory;
    if (!mem) return;
    switch (kind) {
      case "memory": await this.broadcast({ type: "memory-sync", data: mem.loadMerged() }); break;
      case "refinement": await this.broadcast({ type: "refinement-sync", data: await mem.readHistory() }); break;
      case "wound":
        if (this.ctx.wound) await this.broadcast({ type: "wound-sync", data: this.ctx.wound.getDiagnoses() });
        break;
    }
  }

  receive(msg: PeerMessage): void {
    this.messages.push(msg);
    this.ctx.emit("peer/message-received", msg);
    if (msg.type === "memory-sync" && this.ctx.memory) {
      const s = msg.data as { entries: any[] };
      for (const e of s.entries) this.ctx.memory.store(e);
    }
  }

  getPeers(): string[] { return Array.from(this.peers); }
  getMessages(): PeerMessage[] { return this.messages; }
}

export default PeersService;
