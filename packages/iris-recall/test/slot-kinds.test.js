const assert = require("assert");

const SLOT_KINDS = ["transcript", "session", "message", "tool_call"];

async function runTests() {
  console.log("Testing slot kinds...");
  assert.ok(Array.isArray(SLOT_KINDS), "SLOT_KINDS should be an array");
  assert.strictEqual(SLOT_KINDS.length, 4, "SLOT_KINDS should have 4 kinds");
  assert.ok(SLOT_KINDS.includes("transcript"), "transcript should be a slot kind");
  assert.ok(SLOT_KINDS.includes("session"), "session should be a slot kind");
  assert.ok(SLOT_KINDS.includes("message"), "message should be a slot kind");
  assert.ok(SLOT_KINDS.includes("tool_call"), "tool_call should be a slot kind");
  console.log("All slot kind assertions passed!");
  process.exit(0);
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
