// test-rlm-status.cjs
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

// Try to import rlm-sdk
try {
  const rlmSdkPath = path.join(__dirname, '../../packages/rlm-sdk/src/index.ts');
  const mod = await import(rlmSdkPath);
  console.log('Imported rlm-sdk index.ts');
} catch (e) {
  console.log('Failed to import rlm-sdk:', e.message);
}

// Try to run a simple rlm.run test
try {
  const { RlmSdkService } = await import('../../packages/rlm-sdk/src/index.js');
  const ctx = {};
  const sdk = new RlmSdkService(ctx);
  console.log('Created RlmSdkService');
  
  // Test spawning
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
} catch (e) {
  console.log('Error in test:', e.message);
} 
