#!/usr/bin/env node
const { RlmSdkService } = require('./packages/rlm-sdk/src/index.ts');

// Mock context for the SDK service
const mockCtx = {
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  emit: () => {},
  get: (key: string) => null,
  reflect: { provide: () => {} },
};

const service = new RlmSdkService(mockCtx, { maxDepth: 5 });

// Test recentSubagents
const recent = service.recentSubagents();
console.log('Recent subagents count:', recent.length);

// Test adding a completed subagent
const handle = { id: 'test-query', name: 'query-subagent', status: 'completed', completedAt: new Date().toISOString(), sessionName: 'test' } as any;
service.recentlyCompleted.unshift(handle);

const recentAfter = service.recentSubagents();
console.log('After adding:', recentAfter.length);
console.log('Added ID:', recentAfter[0]?.id);

// Export the result as JSON
console.log(JSON.stringify({ recentCount: recentAfter.length, addedId: recentAfter[0]?.id }));
