import { Service } from "@deepseek-ai/cordis";

/**
 * Vision frame — a captured visual snapshot.
 */
export interface VisionFrame {
  id: string;
  timestamp: number;
  width: number;
  height: number;
  /** Base64-encoded PNG data */
  data: string;
  source?: string;
}

/**
 * Vision state tracked per context.
 */
interface VisionState {
  active: boolean;
  frameId: string | null;
  lastCapture: number;
  intervalMs: number;
}

const VISION_MAP = new Map<string, VisionState>();

/**
 * Capture a vision frame for a context.
 */
export function captureVision(
  contextId: string,
  width: number,
  height: number,
  data: string,
  opts: { source?: string; intervalMs?: number } = {}
): VisionFrame {
  const id = `frame-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const frame: VisionFrame = { id, timestamp: Date.now(), width, height, data, source: opts.source };

  const existing = VISION_MAP.get(contextId) ?? { active: false, frameId: null, lastCapture: 0, intervalMs: 1000 };
  VISION_MAP.set(contextId, {
    active: true,
    frameId: id,
    lastCapture: frame.timestamp,
    intervalMs: opts.intervalMs ?? existing.intervalMs,
  });

  return frame;
}

/**
 * Get the current vision state for a context.
 */
export function getVisionState(contextId: string): VisionState | null {
  return VISION_MAP.get(contextId) ?? null;
}

/**
 * Stop vision capture for a context.
 */
export function stopVision(contextId: string): void {
  const existing = VISION_MAP.get(contextId);
  if (existing) {
    VISION_MAP.set(contextId, { ...existing, active: false });
  }
}

/**
 * Clear vision state for a context.
 */
export function clearVision(contextId: string): void {
  VISION_MAP.delete(contextId);
}

export class IrisVision extends Service {
  static provide() {
    return {
      iris: {
        vision: {
          capture: captureVision,
          state: getVisionState,
          stop: stopVision,
          clear: clearVision,
        },
      },
    };
  }
}

export default IrisVision;
export const name = "iris-vision";
