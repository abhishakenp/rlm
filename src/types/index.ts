export interface SessionEvent {
  type: string;
  seq: number;
  time: number;
  data: unknown;
  ignorable?: boolean;
}

export type SessionEventType =
  | "turn/start"
  | "turn/end"
  | "step/start"
  | "step/end"
  | "user/message"
  | "assistant/chunk"
  | "assistant/message"
  | "tool/call"
  | "tool/result"
  | "todo/write"
  | "refine/plan"
  | "refine/apply"
  | "refine/swap"
  | "refine/complete"
  | "refine/failed"
  | "wound/detected"
  | "wound/healed"
  | "wound/unhealed"
  | "reflect/complete"
  | "reflect/proposal"
  | "reflect/journal"
  | "plugin/swapped"
  | "session/end-seed";

export interface HarnessEntry {
  kind: "prompt" | "memory" | "skill" | "subagent";
  title: string;
  content: string;
  reference?: string;
  arguments?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  scope: "global" | "session";
  version: number;
}

export interface HarnessState {
  entries: HarnessEntry[];
}

export interface RefinementProposal {
  id: string;
  kind: "harness" | "plugin-source";
  action: "create" | "update" | "delete";
  target: string;
  edits: RefinementEdit[];
  reason: string;
  trigger: "manual" | "auto" | "wound" | "reflect";
}

export interface RefinementEdit {
  path: string;
  content: string;
  oldContent?: string;
}

export interface WoundDiagnosis {
  pluginId: string;
  toolName?: string;
  error: string;
  pattern: string;
  severity: "low" | "medium" | "high";
  timestamp: number;
}

export interface ReflectionResult {
  journal: string;
  proposals: RefinementProposal[];
  learnedRules: string[];
  fixEvaluation?: {
    fixId: string;
    worked: boolean;
    notes: string;
  };
}
