#!/usr/bin/env node
const sessionId = process.argv.find(arg => arg.startsWith('--session-id='));
if (sessionId) {
  const value = sessionId.split('=')[1];
  console.log('Session ID from argument:', value);
} else {
  console.log('No session ID provided via argument');
}
console.log('Script session ID:', 'my-session-123');
