// test-iris-spawn.js
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// Spawn iris process
const irisProcess = spawn('npx', ['tsx', path.join(__dirname, '../../packages/rlm-iris/src/index.ts')], {
  stdio: ['pipe', 'pipe', 'inherit'],
  cwd: path.join(__dirname, '../../packages/rlm-iris')
});

let output = '';

irisProcess.stdout.on('data', (data) => {
  output += data.toString();
  console.log('Iris stdout:', data.toString());
});

irisProcess.stderr.on('data', (data) => {
  console.error('Iris stderr:', data.toString());
});

// Send messages to iris process
const sendMessage = (msg) => {
  irisProcess.stdin.write(msg + '
');
};

// Wait for iris to be ready, then send status command
irisProcess.stdout.on('end', () => {
  console.log('Iris process ended, output:', output);
});

// Give it a moment to start
setTimeout(() => {
  // Try to send the status command
  sendMessage('iris rlm.status');
}, 1000);
