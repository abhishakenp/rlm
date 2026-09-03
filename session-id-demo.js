#!/usr/bin/env node
// Session ID demonstration script
const sessionIdFromArg = process.argv.find(arg => arg.startsWith('--session-id='));
const providedId = sessionIdFromArg ? sessionIdFromArg.split('=')[1] : null;

console.log('=== Session ID Demonstration ===');
console.log('Provided via argument:', providedId || 'None');
console.log('Current session ID:', 'my-session-123');
console.log('
Usage examples:');
console.log('  node this-script.js --session-id my-session-123');
console.log('  rlm run task --session-id my-session-123');
console.log('  ./session-demo.sh --session-id my-session-123');
