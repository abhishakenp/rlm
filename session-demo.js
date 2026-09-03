#!/usr/bin/env node
const sessionId = process.argv.find(arg => arg.startsWith('--session-id='));
if (sessionId) {
  console.log('Session ID:', sessionId.split('=')[1]);
} else {
  console.log('No session ID provided');
}
console.log('Script running with ID: session-demo');
