#!/usr/bin/env node
console.log("Session ID script running");
for (let i = 0; i < process.argv.length; i++) {
  if (process.argv[i] === "--session-id") {
    console.log("Found session-id:", process.argv[i+1]);
    process.exit(0);
  }
}
console.log("No session-id found");
