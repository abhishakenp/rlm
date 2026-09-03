/**
 * Types extracted from docs/outloop.md §3 and §8.3.
 * Nothing to run — this file is the contract.
 */

// ─── §3: The contract ────────────────────────────────────────────────────────

export interface ReviewCase {
  graphId: string
  taskId: string
  /** The request as it arrived, verbatim. `graph.goal`. */
  request: string
  /** The asker's one line for this task. `task.title`. */
  title: string
  /** What the agent was actually told. `task.prompt`. */
  prompt: string
  /** The structured criterion. */
  proof: Proof
  /** The criterion as a sentence — `describeProof(proof)`. */
  criterion: string
  /** What the criterion printed when it passed. */
  evidence: string
  /** What the agent said it did. Read with suspicion: the claim, not the proof. */
  claim: string
  /** ISO. When the work began — the attempt whose proof passed. */
  startedAt: string
}

/** Three outcomes, not two. See §6.5 — `unsure` is why me-2 can be trusted. */
export type Verdict = "accepted" | "rejected" | "unsure"

export interface Judgement {
  verdict: Verdict
  /** One paragraph, for the journal and for him. */
  reason: string
  /**
   * For a rejection: the span of `request` the criterion does not cover,
   * quoted literally. Checked as a substring before anything is recorded.
   * A rejection without one is downgraded to `unsure`.
   */
  quote?: string
  /** Which mechanical concern (§5.3) or rubric rule (§7) this rests on. */
  cites?: string[]
  /** Which layer decided: the deductive floor, or the reading on top of it. */
  by: "floor" | "reading"
}

/**
 * How the loops reach a model.
 *
 * One prompt in, one string out, no tool loop. Injected rather than imported so
 * the loops can be driven by a stand-in in tests — the pattern
 * `packages/rlm-delegate/workflow.test.ts` already uses for the planner.
 *
 * The real implementation is §9. It is `completeSimple` from `packages/ai`,
 * NOT `rlmSdk.spawn` — spawn runs a whole agent.
 */
export type Ask = (prompt: string, options?: { name?: string; maxTokens?: number }) => Promise<string>

/** me-2. Pure: text in, judgement out. No disk, no graph, no side effects. */
export type Reviewer = (job: ReviewCase, rubric: Rubric, ask: Ask) => Promise<Judgement>

/** me-1. See §8. */
export type Proposer = (input: ProposalInput, rubric: Rubric, ask: Ask) => Promise<Proposal[]>

// ─── §8.3: Types ─────────────────────────────────────────────────────────────

export interface ProposalInput {
  /** His utterances, newest first. See §12.6 for how these are read. */
  said: Utterance[]
  /** Every goal already in the graph, for the gap in §8.1.2. */
  known: string[]
  /** Hard ceiling on how many proposals may come back. Default 3. */
  limit: number
}

export interface Proposal {
  /** One line, in his voice, as the graph's `title` would read. */
  ask: string
  /** HIS words. Gated as a substring of a real transcript line. */
  quote: string
  source: string
  /** How many distinct utterances support it. 1 is allowed but weak. */
  seen: number
  /** A criterion, if one can honestly be named. Otherwise omitted → `unstated`. */
  proof?: Proof
}

// ─── Referenced types (defined elsewhere in the spec) ────────────────────────

export interface Rule {
  id: string          // "R7"
  objection: string   // one line, the standing objection, in the imperative
  quote: string       // HIS words, verbatim, from a transcript
  source: string      // file + line + ISO timestamp — so it can be looked up
  seen: number        // how many distinct utterances support it
}
export type Rubric = Rule[]

export interface Utterance {
  text: string      // his words, trailer stripped
  at: string        // ISO
  source: string    // "iris.jsonl:317" | "g-2026…-injn.jsonl:1"
  spoken: boolean   // the "He said this out loud" marker was present
}

// Proof is defined in packages/rlm-delegate (Task["proof"])
import type { Proof } from "../rlm-delegate/dist/types.js"
