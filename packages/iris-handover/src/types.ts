// Type definitions for handover state transfer

export interface HandoverConfig {
  preservePlayback: boolean;
  preserveSynthesis: boolean;
  timeoutMs: number;
}

export interface HandoverResult {
  success: boolean;
  transferredSessions: string[];
  errors: string[];
}