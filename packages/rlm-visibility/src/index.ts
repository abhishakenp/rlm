/**
 * @rlm/visibility — a visibility surface for monitoring task execution and outer
 * loop activity, following docs/outloop.md §10.2 "Visibility — he wants to attach
 * and watch".
 *
 * Three surfaces, all already house style:
 *
 *   1. Events — mirror the outloop event names: rlm/outloop-reviewing,
 *      -verdict, -unsure, -proposed. rlm-delegate already emits rlm/delegate-reviewed
 *      when a verdict lands; we re-emit on the outloop names so callers that use
 *      the §10.2 vocabulary work without needing to know the delegate internals.
 *
 *   2. Prompt fragment — registered the way rlm-delegate registers its two:
 *      registerFragment("rlm-visibility", { id: "under-review", … }), content read
 *      from disk at build time, never captured at mount.
 *
 *   3. Query API — rlmDelegate gives us the graph; we expose a clean public surface.
 *
 * Nothing here is a background process with opinions. It watches and reports.
 */
import { Service } from "@deepseek-ai/cordis"; 

declare module "@deepseek-ai/cordis" {
  interface Events {
    "rlm/outloop-reviewing"(data: { graph: string; task: string; title: string }): void; 
    "rlm/outloop-verdict"(data: { graph: string; task: string; verdict: "accepted" | "rejected"; by: string; reason: string }): void; 
    "rlm/outloop-unsure"(data: { graph: string; task: string; title: string; why?: string }): void; 
    "rlm/outloop-refined"(data: { graph: string; task: string; into: number }): void; 
    "rlm/outloop-started"(data: { graph: string; task: string; title: string; executor?: string }): void; 
    "rlm/outloop-ended"(data: { graph: string; task: string; title: string; state: string; detail?: string }): void; 
  }
}

export const name = "rlm-visibility"; 

export interface RlmVisibilityConfig {
  eventLogSize?: number; 
  promptLiveWork?: boolean; 
  promptPriority?: number; 
}

export const configFields = [
  { key: "eventLogSize", type: "number", default: 200, description: "Maximum events to retain in the in-memory event log." },
  { key: "promptLiveWork", type: "boolean", default: true, description: "Show what is currently being worked on in the system prompt." },
  { key: "promptPriority", type: "number", default: 89, description: "Priority of the visibility prompt fragment. Higher renders first." },
]; 

export interface VisibilityTask {
  graph: string; 
  task: string; 
  title: string; 
  state: string; 
  priority?: number; 
  proof: string; 
  createdAt: string; 
  updatedAt: string; 
  attempts?: number; 
  reason?: string; 
  review?: { by: string; at: string; verdict: string; reason: string }; 
  executor?: string; 
}

export interface VisibilityEvent {
  at: string; 
  name: string; 
  graph: string; 
  task: string; 
  data: Record<string, unknown>; 
}

export interface VisibilitySummary {
  graphs: number; 
  total: number; 
  done: number; 
  running: number; 
  ready: number; 
  blocked: number; 
  failed: number; 
  unproven: number; 
  rejected: number; 
  unreachable: number; 
  recentEvents: VisibilityEvent[]; 
}

export class RlmVisibilityService extends Service {
  static inject = [] as const; 
  static provide = "rlmVisibility" as const; 

  declare config: RlmVisibilityConfig; 

  private teardowns = new Set<() => void>(); 
  private _events: VisibilityEvent[] = []; 
  private _live: Map<string, VisibilityTask> = new Map(); 

  constructor(ctx: any, config: RlmVisibilityConfig = {}) {
    super(ctx, undefined as any); 
    this.config = typeof config === "object" && !Array.isArray(config) ? config : {}; 
  }

  async [Service.init]() {
    const sub = (name: string, outloopName: string, transform?: (d: any) => any) => {
      const handler = (data: any) => {
        const d = transform ? transform(data) : data; 
        this.pushEvent({ at: new Date().toISOString(), name: outloopName, graph: d.graph, task: d.task, data: d }); 
        (this.ctx.emit as any)?.(outloopName, d); 
      }; 
      const dispose = (this.ctx.on as any)?.(name, handler); 
      if (typeof dispose === 'function') this.teardowns.add(dispose); return 
    }; 

    sub("rlm/delegate-declared", "rlm/outloop-reviewing"); 
    sub("rlm/delegate-reviewed", "rlm/outloop-verdict"); 
    sub("rlm/delegate-unproven", "rlm/outloop-unsure"); 
    sub("rlm/delegate-refined", "rlm/outloop-refined"); 
    sub("rlm/delegate-failed", "rlm/outloop-ended", (d: any) => ({ ...d, state: "failed" })); 

    this.trackLiveFromDelegate(); 
    const interval = setInterval(() => this.trackLiveFromDelegate(), 30_000); 
    this.teardowns.add(() => clearInterval(interval)); 
    this.attachPrompt(); 
  }

  private attachPrompt() {
    const prompt = this.ctx.get?.("rlmPrompt"); 
    if (!prompt?.registerFragment) return; 

    const frag = prompt.registerFragment("rlm-visibility", {
      id: "live-work",
      priority: this.config.promptPriority ?? 89,
      when: "always",
      content: () => (this.config.promptLiveWork !== false ? this.liveFragment() : ""),
    }); 
    if (frag?.dispose) this.teardowns.add(() => frag.dispose()); 

    this.ctx.effect?.(() => {
      return () => {
        for (const off of this.teardowns) {
          try { off(); } catch { /* noop */ }
        }
        this.teardowns.clear(); 
      }; 
    }, "rlm-visibility teardown"); 
  }

  private liveFragment(): string {
    const live = this.liveTasks(); 
    if (!live.length) return ""; 

    const now = new Date().toISOString(); 
    const running = live.filter((t) => t.state === "running"); 
    const ready = live.filter((t) => t.state === "ready"); 
    const lines: string[] = []; 

    if (running.length) {
      lines.push("### Currently running", ""); 
      for (const t of running) {
        const age = t.updatedAt ? this.age(t.updatedAt, now) : ""; 
        const exec = t.executor ? " (" + t.executor + ")" : ""; 
        lines.push("  " + t.graph + "/" + t.task + exec + (age ? " - " + age : "") + "  " + t.title); 
      }
    }

    if (ready.length) {
      lines.push("", "### Ready to pick up", ""); 
      for (const t of ready.slice(0, 20)) {
        lines.push("  " + t.graph + "/" + t.task + "  " + t.title); 
      }
      if (ready.length > 20) lines.push("  ...and " + (ready.length - 20) + " more"); 
    }

    const recent = this._events.slice(-10); 
    if (recent.length) {
      lines.push("", "### Recent visibility events", ""); 
      for (const ev of recent) {
        const when = this.age(ev.at, now); 
        lines.push("  " + (when ? when + " " : "") + ev.name + "  " + ev.graph + "/" + ev.task); 
      }
    }

    if (!lines.length) return ""; 
    return ["## What is being worked on", "", ...lines, ""].join("\n"); 
  }

  private trackLiveFromDelegate() {
    const delegate = this.ctx.get?.("rlmDelegate") as any; 
    if (!delegate?.open) return; 

    let graphs: any[] = []; 
    try { graphs = delegate.open(); } catch { return; }

    const next = new Map<string, VisibilityTask>(); 

    for (const graph of graphs) {
      for (const task of graph.tasks ?? []) {
        if (task.state === "done") continue; 
        const key = graph.id + "/" + task.id; 
        next.set(key, {
          graph: graph.id,
          task: task.id,
          title: task.title,
          state: task.state,
          priority: task.priority,
          proof: this.describeProof(task.proof),
          createdAt: task.createdAt,
          updatedAt: task.updatedAt,
          attempts: task.attempts?.length,
          reason: task.reason,
          review: task.review,
          executor: task.attempts?.at(-1)?.executor,
        }); 
      }
    }

    for (const [key, t] of next) {
      const prev = this._live.get(key); 
      if (!prev) {
        if (t.state === "running") {
          const ev = { at: new Date().toISOString(), name: "rlm/outloop-started", graph: t.graph, task: t.task, data: { graph: t.graph, task: t.task, title: t.title, executor: t.executor } }; 
          this.pushEvent(ev); 
          this.ctx.emit?.("rlm/outloop-started", ev.data); 
        }
      } else if (prev.state !== t.state && t.state !== "running") {
        const ended = { ...prev, state: t.state, detail: t.reason }; 
        const ev = { at: new Date().toISOString(), name: "rlm/outloop-ended", graph: t.graph, task: t.task, data: ended }; 
        this.pushEvent(ev); 
        this.ctx.emit?.("rlm/outloop-ended", ended); 
      }
    }

    this._live = next; 
  }

  private pushEvent(event: VisibilityEvent) {
    this._events.push(event); 
    const max = this.config.eventLogSize ?? 200; 
    if (this._events.length > max) this._events.splice(0, this._events.length - max); 
  }

  liveTasks(): VisibilityTask[] {
    this.trackLiveFromDelegate(); 
    return [...this._live.values()]; 
  }

  tasksByState(state: string): VisibilityTask[] {
    return this.liveTasks().filter((t) => t.state === state); 
  }

  eventLog(): VisibilityEvent[] {
    return [...this._events]; 
  }

  clearLog() {
    this._events = []; 
  }

  summary(): VisibilitySummary {
    const live = this.liveTasks(); 
    const byState: Record<string, number> = {}; 
    for (const t of live) byState[t.state] = (byState[t.state] ?? 0) + 1; 

    return {
      graphs: new Set(live.map((t) => t.graph)).size,
      total: live.length,
      done: this.doneCount(),
      running: byState["running"] ?? 0,
      ready: byState["ready"] ?? 0,
      blocked: byState["blocked"] ?? 0,
      failed: byState["failed"] ?? 0,
      unproven: byState["unproven"] ?? 0,
      rejected: byState["rejected"] ?? 0,
      unreachable: byState["unreachable"] ?? 0,
      recentEvents: this._events.slice(-20),
    }; 
  }

  private doneCount(): number {
    const delegate = this.ctx.get?.("rlmDelegate") as any; 
    if (!delegate?.open) return 0; 
    let graphs: any[] = []; 
    try { graphs = delegate.open(); } catch { return 0; }
    return graphs.reduce((n: number, g: any) => n + (g.tasks?.filter((t: any) => t.state === "done").length ?? 0), 0); 
  }

  private describeProof(proof: any): string {
    if (!proof) return "(unknown)"; 
    switch (proof.kind) {
      case "shell": return "`" + proof.run + "` exits 0"; 
      case "file": return proof.contains ? proof.path + " contains \"" + proof.contains + "\"" : proof.path + " exists"; 
      case "row": return "row " + proof.id + " reaches " + (proof.state ?? "ACTIVE"); 
      case "command": return "command " + proof.name + " is in the registry"; 
      case "rollup": return "everything it was broken into is done"; 
      case "unstated": return "nobody said how to tell"; 
      default: return proof.kind; 
    }
  }

  private age(from: string, to: string): string {
    const ms = new Date(to).getTime() - new Date(from).getTime(); 
    if (ms < 0) return ""; 
    const s = Math.floor(ms / 1000); 
    if (s < 60) return s + "s ago"; 
    const m = Math.floor(s / 60); 
    if (m < 60) return m + "m ago"; 
    const h = Math.floor(m / 60); 
    return h + "h ago"; 
  }

  render(): string {
    const summary = this.summary(); 
    if (!summary.total) return "Nothing being worked on right now."; 

    const lines: string[] = []; 
    lines.push("Visibility - " + summary.graphs + " graph(s), " + summary.total + " live task(s), " + summary.done + " done"); 

    const running = this.tasksByState("running"); 
    if (running.length) {
      lines.push("", "Running:"); 
      for (const t of running) lines.push("  " + t.graph + "/" + t.task + "  " + t.title); 
    }

    const ready = this.tasksByState("ready"); 
    if (ready.length) {
      lines.push("", "Ready (" + ready.length + "):"); 
      for (const t of ready.slice(0, 15)) lines.push("  " + t.graph + "/" + t.task + "  " + t.title); 
      if (ready.length > 15) lines.push("  ..." + (ready.length - 15) + " more"); 
    }

    const stopped = summary.total - running.length - ready.length; 
    if (stopped) {
      lines.push("", "Stopped/waiting: " + stopped + " - use rlm tasks to see them"); 
    }

    return lines.join("\n"); 
  }
}

export default RlmVisibilityService; 
