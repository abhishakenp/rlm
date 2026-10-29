/**
 * Fleet Queue Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fetch for all tests
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('FleetQueue', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  describe('checkAndAdmit', () => {
    it('should admit when within concurrency limit', async () => {
      const { FleetQueue } = await import('../src/queue.js');

      const queue = new FleetQueue({
        maxConcurrency: 5,
        queueLabel: 'rlm-task',
        inProgressLabel: 'rlm-in-progress',
        completedLabel: 'rlm-completed',
        repoOwner: 'test-owner',
        repoName: 'test-repo',
        githubToken: 'test-token',
      });

      const result = await queue.checkAndAdmit(3, 'Test task');
      
      expect(result.admitted).toBe(true);
      expect(result.runId).toBeDefined();
      expect(result.runId.startsWith('run-')).toBe(true);
      expect(result.reason).toContain('Within concurrency limit');
    });

    it('should queue when concurrency exceeded', async () => {
      const { FleetQueue } = await import('../src/queue.js');

      // Mock GitHub API response
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          number: 42,
          title: 'Task: Test task',
          body: 'Test task body',
          state: 'open',
          labels: ['rlm-task'],
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }),
      });

      const queue = new FleetQueue({
        maxConcurrency: 5,
        queueLabel: 'rlm-task',
        inProgressLabel: 'rlm-in-progress',
        completedLabel: 'rlm-completed',
        repoOwner: 'test-owner',
        repoName: 'test-repo',
        githubToken: 'test-token',
      });

      const result = await queue.checkAndAdmit(5, 'Test task');
      
      expect(result.admitted).toBe(false);
      expect(result.issueNumber).toBe(42);
      expect(result.reason).toContain('Concurrency exceeded');
    });
  });

  describe('getQueueDepth', () => {
    it('should return zero when no queued issues', async () => {
      const { FleetQueue } = await import('../src/queue.js');

      // Mock empty issues list
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      });

      const queue = new FleetQueue({
        maxConcurrency: 5,
        queueLabel: 'rlm-task',
        inProgressLabel: 'rlm-in-progress',
        completedLabel: 'rlm-completed',
        repoOwner: 'test-owner',
        repoName: 'test-repo',
        githubToken: 'test-token',
      });

      const depth = await queue.getQueueDepth();
      expect(depth).toBe(0);
    });
  });
});

describe('GitHubApiHandler', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  describe('formatCompletionComment', () => {
    it('should format completion comment correctly', () => {
      const { GitHubApiHandler } = require('../dist/github-api.js');

      const metadata = {
        runId: 'run-123',
        issueNumber: 42,
        issueUrl: 'https://github.com/owner/repo/issues/42',
        dispatchedAt: '2024-01-01T12:00:00Z',
        completedAt: '2024-01-01T12:30:00Z',
        status: 'success',
        repoUrl: 'https://github.com/owner/repo',
        runUrl: 'https://github.com/owner/repo/actions/runs/123',
      };

      const comment = GitHubApiHandler.formatCompletionComment(metadata);
      
      expect(comment).toContain('Run Completed');
      expect(comment).toContain('run-123');
      expect(comment).toContain('#42');
      expect(comment).toContain('success');
    });
  });

  describe('formatPromotionComment', () => {
    it('should format promotion comment correctly', () => {
      const { GitHubApiHandler } = require('../dist/github-api.js');

      const comment = GitHubApiHandler.formatPromotionComment('run-456', 'https://example.com/run');
      
      expect(comment).toContain('Promotion Status');
      expect(comment).toContain('In Progress');
      expect(comment).toContain('run-456');
      expect(comment).toContain('https://example.com/run');
    });
  });
});
