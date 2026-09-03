// minimal-rlm-test.js
import { RlmSdkService } from '../../packages/rlm-sdk/src/index.js';

// Create context and SDK instance
const ctx = {};
const sdk = new RlmSdkService(ctx);
console.log('SDK initialized');

// Test spawning a subagent
(async () => {
  try {
    console.log('Spawning first subagent...');
    const handle1 = await sdk.run('First test prompt', { name: 'test-1' });
    console.log('First subagent completed:', handle1);
    
    console.log('Spawning second subagent...');
    const handle2 = await sdk.run('Second test prompt', { name: 'test-2' });
    console.log('Second subagent completed:', handle2);
    
    // Wait a moment for tracking to update
    await new Promise(resolve => setTimeout(resolve, 100));
    
    const recent = sdk.recentSubagents();
    console.log('recentSubagents() returned:', recent);
    console.log('Length:', recent.length);
    console.log('Content:', JSON.stringify(recent, null, 2));
    
    // Check if recent array is non-empty
    if (recent.length > 0) {
      console.log('SUCCESS: recent array is non-empty');
      process.exit(0);
    } else {
      console.log('FAILURE: recent array is empty');
      process.exit(1);
    }
  } catch (e) {
    console.log('Error:', e.message);
    process.exit(1);
  }
})();
