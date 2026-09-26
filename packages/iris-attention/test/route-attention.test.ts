/**
 * routeAttention prefix/focus semantics — moved from the Sep 6 iris-dictation
 * attempt (packages/iris-dictation/test/utterance-matching.test.ts), whose own
 * code never ran; these cases test iris-attention itself.
 * Run: `bun test packages/iris-attention/test/route-attention.test.ts`.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { routeAttention, setFocus, clearAttention, getAttention } from '../src/index.ts';

describe('routeAttention', () => {
  const testContextId = 'test-context';

  beforeEach(() => {
    clearAttention(testContextId);
  });

  describe('prefix matching', () => {
    it('should match when input starts with prefix "iris"', () => {
      const result = routeAttention(testContextId, 'iris hello', { prefix: 'iris' });
      expect(result.matched).toBe(true);
    });

    it('should NOT match when input does not start with prefix', () => {
      const result = routeAttention(testContextId, 'random text', { prefix: 'iris' });
      expect(result.matched).toBe(false);
      expect(result.state).toBe(null);
    });

    it('should match with exact prefix match', () => {
      const result = routeAttention(testContextId, 'iris command', { prefix: 'iris' });
      expect(result.matched).toBe(true);
      expect(result.state).not.toBeNull();
    });

    it('should not match partial prefix', () => {
      const result = routeAttention(testContextId, 'iridescent', { prefix: 'iris' });
      expect(result.matched).toBe(false);
    });
  });

  describe('state persistence', () => {
    it('should return state even when no match', () => {
      const result = routeAttention(testContextId, 'no match', { prefix: 'iris' });
      expect(result.state).toBe(null);
    });
  });
});
