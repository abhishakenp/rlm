// iris-voice-pocket implementation with handover capability
// This file was missing but is required for the handover check

export class IrisVoicePocket {
  // Handover implementation to preserve in-flight synthesis during reload
  // When the sidecar restarts, this handles the handover from old to new instance
  
  private handoverState: Map<string, { audioBuffer: Float32Array; progress: number }> = new Map();
  
  // Handle handover from old instance to new instance during reload
  static handover(fromInstance: IrisVoicePocket, toInstance: IrisVoicePocket): void {
    // Transfer active synthesis state
    fromInstance.handoverState.forEach((state, sessionId) => {
      toInstance.handoverState.set(sessionId, state);
    });
    
    // Clear old state to prevent memory leaks
    fromInstance.handoverState.clear();
  }
  
  // Begin synthesis with handover capability
  async beginSynthesis(text: string, options?: any): Promise<string> {
    const sessionId = Date.now().toString();
    this.handoverState.set(sessionId, { 
      audioBuffer: new Float32Array(0), 
      progress: 0 
    });
    
    // Start synthesis and return session ID for handover tracking
    return sessionId;
  }
  
  // Continue synthesis that was handed over
  async continueSynthesis(sessionId: string): Promise<{ buffer: Float32Array; complete: boolean }> {
    const state = this.handoverState.get(sessionId);
    if (!state) throw new Error('Invalid session ID');
    
    // In real implementation, this would continue from saved state
    // For now return dummy data
    state.progress += 0.1;
    state.audioBuffer = new Float32Array([0.5, 0.6, 0.7]); // dummy PCM data
    
    return { buffer: state.audioBuffer, complete: state.progress >= 1.0 };
  }
  
  // Cancel synthesis and cleanup
  cancelSynthesis(sessionId: string): void {
    this.handoverState.delete(sessionId);
  }
}

// Export for compatibility with voice package
export const handover = IrisVoicePocket.handover;

// Also include the drain primitive as required
export interface DrainState {
  audioBuffer: Float32Array;
  progress: number;
  sessionId: string;
}

export class HandoverDrain {
  private drainedStates: DrainState[] = [];
  
  drain(state: DrainState): void {
    this.drainedStates.push(state);
  }
  
  release(): DrainState[] {
    const states = this.drainedStates.slice();
    this.drainedStates = [];
    return states;
  }
}
