#!/usr/bin/env tsx
console.log("Session ID script running"); 
for (let i = 0; i < process.argv.length; i++) {
  if (process.argv[i] === "--session-id") {
    console.log("Found session-id:", process.argv[i+1]); return 
  }
}

