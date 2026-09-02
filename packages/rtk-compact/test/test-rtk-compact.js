#!/usr/bin/env node
const assert = require('assert'); 
const path = require('path'); 
const fs = require('fs'); 

// Import the package
const rtkCompact = require('../src/index'); 

console.log('Testing rtk-compact...'); 

// Test 1: Simple transcript compaction
function runTest1() {
  const input = {
    user: [
      {role: 'user', content: 'Hello world'},
      {role: 'assistant', content: 'Hi there'},
      'Another user message'
    ],
    agent: [{role: 'assistant', content: 'Agent response'}],
    metadata: 'should be ignored'
  }; 
  
  const inputPath = path.join(__dirname, 'test-input.json'); 
  const outputPath = path.join(__dirname, 'test-output.json'); 
  
  // Write input to file
  fs.writeFileSync(inputPath, JSON.stringify(input)); 
  
  const success = rtkCompact.compactTranscript(inputPath, outputPath); 
  assert.strictEqual(success, true); 
  
  const output = JSON.parse(fs.readFileSync(outputPath, 'utf8')); 
  assert.deepStrictEqual(output.user, ['Hello world', 'Another user message']); 
  assert.strictEqual(output.user.length, 2); 
  assert.strictEqual(output.agent.length, 0); 
  fs.unlinkSync(inputPath); 
  fs.unlinkSync(outputPath); 
  console.log('Test 1 passed'); 
}

// Test 2: Batch compaction
function runTest2() {
  const testDir = path.join(__dirname, 'testdata'); 
  fs.mkdirSync(testDir, { recursive: true }); 
  
  // Create test files
  fs.writeFileSync(path.join(testDir, 'transcript1.json'), JSON.stringify({
    user: [{role: 'user', content: 'First message'}, {role: 'assistant', content: 'Response'}],
    agent: []
  })); 
  
  fs.writeFileSync(path.join(testDir, 'transcript2.json'), JSON.stringify([
    {role: 'assistant', content: 'AI response'},
    {role: 'user', content: 'Second user message'}
  ])); 
  
  const results = rtkCompact.compactDirectory(testDir, path.join(testDir, 'output')); 
  assert.deepStrictEqual(results, {'transcript1.json': 'compacted', 'transcript2.json': 'compacted'}); 
  
  const output1 = JSON.parse(fs.readFileSync(path.join(testDir, 'output/transcript1.json'), 'utf8')); 
  assert.strictEqual(output1.user.length, 1); 
  assert.strictEqual(output1.user[0], 'First message'); 
  
  fs.rmSync(testDir, { recursive: true, force: true }); 
  console.log('Test 2 passed'); 
}

runTest1(); 
runTest2(); 
console.log('All tests passed!'); return 
