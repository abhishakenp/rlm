#!/usr/bin/env node
// Session ID Demonstration Script
// Usage: node this-script.js --session-id <id>

const args = process.argv;
const sessionArg = args.find(arg => arg.startsWith("--session-id="));
const providedId = sessionArg ? sessionArg.split("=")[1] : null;

console.log("=== Session ID Demonstration ===");
console.log("Command used:", args.slice(0, 3).join(" "));
console.log("Provided session ID:", providedId || "None");
console.log("Current session ID variable:", "my-session-123");

console.log("--- Usage Examples ---");
console.log("1. JavaScript:");
console.log("   const sessionId = process.argv.find(arg => arg.startsWith("--session-id="));");
console.log("   const id = sessionId?.split("=")[1];");
console.log("2. Shell script:");
console.log("   for arg in "$@"; do");
console.log("     if [[ "$arg" == --session-id=* ]]; then");
console.log("       echo "${arg#*--session-id=}";");
console.log("     fi");
console.log("   done");
console.log("3. rlm command:");
console.log("   rlm run task --session-id", sessionId);
console.log("4. Gitpixel command:");
console.log("   gitpixel search --session-id", sessionId);

console.log("--- Session ID Purpose ---");
console.log("Session IDs are used to:");
console.log("• Group related work across multiple tools");
console.log("• Track progress and results per session");
console.log("• Enable cross-tool communication and state sharing");
console.log("• Support delegation and subagent coordination");