// Handover drain primitive implementation
// This package provides the drain mechanism used during voice reload handover

export interface DrainState {
  audioBuffer: Float32Array;
  progress: number;
  sessionId: string;
  timestamp: number;
}

export class HandoverDrain {
  // Drain state from old instance during reload
  drain(state: DrainState): void {
    // Implementation would save state to persistent storage
    // For now, this represents the drain primitive interface
    console.log('Draining handover state:', state);
  }

  // Release drained states to new instance
  release(): DrainState[] {
    // Implementation would retrieve and return drained states
    return [];
  }
}

// Export for use in voice packages
export default HandoverDrain;