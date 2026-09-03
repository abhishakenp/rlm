// test-rlm-status.js
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Try to import rlm-sdk
try {
  const rlmSdkPath = path.join(__dirname, '../../packages/rlm-sdk/src/index.ts');
  const mod = require(rlmSdkPath);
  console.log('Imported rlm-sdk index.ts');
} catch (e) {
  console.log('Failed to import rlm-sdk:', e.message);
}

// Try to run iris command
try {
  const result = execSync('npx tsx ../../packages/rlm-iris/src/index.ts', { encoding: 'utf8', stdio: 'pipe' });
  console.log('Result from rlm-iris index.ts:', result);
} catch (e) {
  console.log('Error running rlm-iris:', e.message);
  console.log('Stderr:', e.stderr);
}

// Try to run a simple rlm.run test
try {
  const { RlmSdkService } = require('../../packages/rlm-sdk/src/index.js');
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
