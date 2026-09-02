#!/usr/bin/env node

const fs = require('fs'); 
const path = require('path'); 

function isUserMessage(msg) {
  if (typeof msg === 'string') return true; 
  if (typeof msg === 'object' && msg !== null) {
    return msg.role === 'user' && typeof msg.content === 'string'; 
  }
  return false; 
}

function extractUserContent(msg) {
  if (typeof msg === 'string') return msg.trim(); 
  if (typeof msg === 'object' && msg !== null && msg.role === 'user') {
    return typeof msg.content === 'string' ? msg.content.trim() : ''; 
  }
  return ''; 
}

function compactTranscript(inputPath, outputPath) {
  try {
    const content = fs.readFileSync(inputPath, 'utf8'); 
    const transcript = JSON.parse(content); 
    
    // Handle different transcript formats
    let userContent = []; 
    
    if (Array.isArray(transcript)) {
      // Raw array format
      userContent = transcript
        .filter(isUserMessage)
        .map(extractUserContent)
        .filter(Boolean); 
    } else if (transcript.user && Array.isArray(transcript.user)) {
      // Object format with user array
      userContent = transcript.user
        .filter(isUserMessage)
        .map(extractUserContent)
        .filter(Boolean); 
    } else if (transcript.messages && Array.isArray(transcript.messages)) {
      // Messages format
      userContent = transcript.messages
        .filter(isUserMessage)
        .map(extractUserContent)
        .filter(Boolean); 
    }
    
    const compacted = {
      user: userContent,
      content: userContent,
      compactedAt: new Date().toISOString(),
      version: 'rtk-compact-v1'
    }; 
    
    fs.writeFileSync(outputPath, JSON.stringify(compacted, null, 2)); 
    console.log(`Compacted ${userContent.length} user messages to ${outputPath}`); 
    return true; 
  } catch (err) {
    console.error('Error compacting transcript:', err.message); 
    return false; 
  }
}

if (require.main === module) {
  const inputFile = process.argv[2]; 
  const outputFile = process.argv[3] || inputFile.replace(/\.json$/, '-compact.json'); 
  
  if (!inputFile) {
    console.log('Usage: rtk-compact <input.json> [output.json]'); 
    process.exit(1); 
  }
  
  if (compactTranscript(inputFile, outputFile)) {
    process.exit(0); 
  } else {
    process.exit(1); 
  }
}

module.exports = { compactTranscript, isUserMessage, extractUserContent }; return 
