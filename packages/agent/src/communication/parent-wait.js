/**
 * Blocking wait mechanism for monitoring inter-agent communication.
 * Waits for a response from the parent agent with timeout support.
 */

const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_CHARS = 16384;

/**
 * Result of waiting for parent response.
 * @typedef {Object} ParentResponseResult
 * @property {boolean} timedOut - Whether the wait timed out
 * @property {string} [message] - The response message content (if not timed out)
 * @property {object} [details] - Additional message details (if not timed out)
 * @property {string} [messageId] - The message ID (if not timed out)
 * @property {number} [elapsedMs] - Time elapsed before response received
 */

/**
 * Options for waitForParentResponse.
 * @typedef {Object} WaitForParentResponseOptions
 * @property {number} [timeoutMs] - Maximum time to wait in milliseconds
 * @property {string} [targetSession] - Session ID to monitor (defaults to current session)
 * @property {AbortSignal} [signal] - AbortSignal for cancellation
 * @property {number} [pollIntervalMs] - Polling interval in milliseconds
 * @property {(type: string, payload: object) => Promise<any>} [request] - Host request function
 *   (defaults to a global `host.request`). Inside an rlm code cell prefer
 *   `agent_message.wait_for_parent(timeout_ms)`, which is handed the message
 *   directly instead of polling.
 */

/**
 * Wait for a parent agent response to a clarification question.
 * 
 * This function blocks until either:
 * - A message from the parent agent is received
 * - The timeout is reached
 * - The abort signal is triggered
 * 
 * @param {number|WaitForParentResponseOptions} optionsOrTimeout - Timeout in ms or options object
 * @param {object} [options] - Options object (if first arg is number)
 * @returns {Promise<ParentResponseResult>}
 */
export async function waitForParentResponse(optionsOrTimeout, options) {
  // Parse arguments
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let targetSession = undefined;
  let signal = undefined;
  let pollIntervalMs = DEFAULT_POLL_INTERVAL_MS;
  let request = undefined;
  
  if (typeof optionsOrTimeout === 'number') {
    timeoutMs = optionsOrTimeout;
    if (options) {
      targetSession = options.targetSession;
      signal = options.signal;
      pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
      request = options.request;
    }
    
  } else if (optionsOrTimeout && typeof optionsOrTimeout === 'object') {
    timeoutMs = optionsOrTimeout.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    targetSession = optionsOrTimeout.targetSession;
    signal = optionsOrTimeout.signal;
    pollIntervalMs = optionsOrTimeout.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    request = optionsOrTimeout.request;
  }
  
  // Validate timeout
  if (timeoutMs <= 0) {
    return { timedOut: true, elapsedMs: 0 };
  }
  
  // Ensure minimum poll interval
  pollIntervalMs = Math.max(100, pollIntervalMs);
  
  const startTime = Date.now();
  let lastSeenIndex = -1;
  
  // Helper to check if we should continue waiting
  const shouldContinue = () => {
    if (signal?.aborted) return false;
    return Date.now() - startTime < timeoutMs;
  };
  
  // Helper to get elapsed time
  const getElapsed = () => Date.now() - startTime;
  
  // Helper to sleep
  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
  
  // Poll for parent messages
  while (shouldContinue()) {
    try {
      // Get recent messages from the session
      const response = await _getRecentMessages(targetSession, 10, DEFAULT_MAX_CHARS, request);
      
      if (response?.messages && Array.isArray(response.messages)) {
        // Find the most recent message from parent
        for (let i = response.messages.length - 1; i >= 0; i--) {
          const msg = response.messages[i];
          
          // Skip if we've already seen this message
          if (msg.index <= lastSeenIndex) continue;
          
          // Check if this is a message from the parent agent
          if (_isParentMessage(msg)) {
            // Extract the message content
            const content = _extractParentMessageContent(msg);
            const details = _extractMessageDetails(msg);
            
            return {
              timedOut: false,
              message: content,
              details,
              messageId: details?.id,
              elapsedMs: getElapsed()
            };
          }
          
          // Update last seen index to avoid reprocessing
          if (msg.index > lastSeenIndex) {
            lastSeenIndex = msg.index;
          }
        }
        
        // Update lastSeenIndex based on latest message
        if (response.messages.length > 0) {
          lastSeenIndex = response.messages[response.messages.length - 1].index;
        }
      }
    } catch (error) {
      // Log but don't fail on transient errors
      console.error('Error polling for parent messages:', error.message);
    }
    
    // Wait before polling again
    await sleep(pollIntervalMs);
  }
  
  // Timeout reached
  return { timedOut: true, elapsedMs: getElapsed() };
}

/**
 * Get recent messages from an agent session.
 * @private
 */
async function _getRecentMessages(target, limit, maxChars, request) {
  try {
    if (typeof request === 'function') {
      return await request('agent_observe.recent', {
        target: target || 'current',
        limit,
        max_chars: maxChars
      });
    }

    // Try the host request mechanism used by the code kernel
    if (typeof host !== 'undefined' && host.request) {
      return await host.request('agent_observe.recent', {
        target: target || 'current',
        limit,
        max_chars: maxChars
      });
    }
    
    // Fallback: try globalThis for environments where host is attached differently
    const globalHost = globalThis.host || globalThis._host;
    if (globalHost && globalHost.request) {
      return await globalHost.request('agent_observe.recent', {
        target: target || 'current',
        limit,
        max_chars: maxChars
      });
    }
    
    return { messages: [] };
  } catch (error) {
    return { messages: [] };
  }
}

/**
 * Check if a message is from the parent agent.
 * @private
 */
function _isParentMessage(msg) {
  if (msg.customType === 'agent_message') {
    return true;
  }
  
  if (msg.text && typeof msg.text === 'string') {
    if (msg.text.includes('[from parent]') || msg.text.includes('Agent-to-agent message received')) {
      return true;
    }
  }
  
  return false;
}

/**
 * Extract the actual message content from a parent message.
 * @private
 */
function _extractParentMessageContent(msg) {
  if (!msg.text) return '';
  
  const text = msg.text;
  const lines = text.split('\n');
  
  let contentStartIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].match(/^Message id: /)) {
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trim() !== '') {
          contentStartIndex = j;
          break;
        }
      }
      break;
    }
  }
  
  if (contentStartIndex >= 0) {
    return lines.slice(contentStartIndex).join('\n').trim();
  }
  
  return text;
}

/**
 * Extract additional details from a message.
 * @private
 */
function _extractMessageDetails(msg) {
  const details = {
    index: msg.index,
    role: msg.role,
    timestamp: msg.timestamp,
    customType: msg.customType
  };
  
  if (msg.text) {
    const match = msg.text.match(/Message id: (agentmsg_[^\n]+)/);
    if (match) {
      details.id = match[1];
    }
  }
  
  return details;
}

export { DEFAULT_TIMEOUT_MS, DEFAULT_POLL_INTERVAL_MS };
