/**
 * rtk-compact - Stricter RTK fork for compacting user transcripts
 * Compacts transcripts to only what the user said, stripping all metadata.
 */

const fs = require('fs'); 
const path = require('path'); 

/**
 * Compacts a transcript file
 * @param {string} inputPath - Path to input transcript JSON file
 * @param {string} outputPath - Path to output compacted transcript JSON file
 * @returns {boolean} - True if successful, false otherwise
 */
function compactTranscript(inputPath, outputPath) {
  try {
    const content = fs.readFileSync(inputPath, 'utf8'); 
    const transcript = JSON.parse(content); 
    
    // Extract only user content, preserving order
    const userContent = []; 
    
    // Handle different transcript formats
    if (Array.isArray(transcript)) {
      // Array format: [{role: 'user', content: '...'}]
      for (const msg of transcript) {
        if (msg.role === 'user' && typeof msg.content === 'string') {
          userContent.push(msg.content.trim()); 
        }
      }
    } else if (transcript.user && Array.isArray(transcript.user)) {
      // Object format with user array
      for (const msg of transcript.user) {
        if (typeof msg === 'string') {
          userContent.push(msg.trim()); 
        } else if (msg.role === 'user' && typeof msg.content === 'string') {
          userContent.push(msg.content.trim()); 
        }
      }
    }
    
    const compacted = {
      user: userContent,
      agent: [],
      content: userContent,
      // Minimal metadata only
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

/**
 * Batch compact multiple transcript files
 */
function compactDirectory(inputDir, outputDir) {
  try {
    if (!fs.existsSync(inputDir)) {
      throw new Error(`Input directory ${inputDir} does not exist`); 
    }
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true }); 
    }
    
    const files = fs.readdirSync(inputDir).filter(f => f.endsWith('.json')); 
    const results = {}; 
    
    for (const file of files) {
      const inputPath = path.join(inputDir, file); 
      const outputPath = path.join(outputDir, file); 
      const success = compactTranscript(inputPath, outputPath); 
      results[file] = success ? 'compacted' : 'failed'; 
    }
    
    console.log('Batch compaction complete:', results); 
    return results; 
  } catch (err) {
    console.error('Error compacting directory:', err.message); 
    return { error: err.message }; 
  }
}

module.exports = {
  compactTranscript,
  compactDirectory
}; return 
