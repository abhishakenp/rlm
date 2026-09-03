// test-rlm-sdk.ts
import { RlmSdkService } from '../../packages/rlm-sdk/src/index.js';

const ctx = {};
const sdk = new RlmSdkService(ctx);
console.log('Created RlmSdkService');

// Test spawning a subagent
(async () => {
  try {
    const handle = await sdk.run('Test prompt', { name: 'test-sub' });
    console.log('Spawned handle:', handle);
    
    const recent = sdk.recentSubagents();
    console.log('recentSubagents:', recent);
  } catch (e) {
    console.log('Error spawning:', e.message);
  }
})();
