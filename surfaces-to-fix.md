# Surfaces Missing Redaction Calls

Redaction design (from packages/rlm-log/src/index.ts):
- safe(): recursive key-name redaction — values at keys matching REDACT are replaced with "[redacted]"
- code-preview.ts also has redactNoise(): value-pattern redaction for API key values, Bearer tokens, etc.

Only rlm-log's own write path calls safe() before persisting. Every surface below outputs user-facing content without calling either function.

---

## 1. HTML Transcript Export

### packages/coding-agent/src/core/export-html/index.ts
Passes raw tool result msg.content directly to toolRenderer.renderResult() without calling safe() or redactNoise(). A tool result containing { "api_key": "sk-..." } gets embedded in the exported HTML verbatim.

### packages/coding-agent/src/core/export-html/tool-renderer.ts
renderResult() passes result (array of {type, text, data, mimeType}) and args to tool-specific renderResult() callbacks without pre-filtering. No redactNoise or safe call on input content.

---

## 2. CLI Print Mode

### packages/coding-agent/src/modes/print-mode.ts
Uses writeRawStdout to emit raw content.text from agent messages without calling safe() or redactNoise(). Lines 129-136 iterate over message content and write text directly to stdout.

### packages/coding-agent/src/core/output-guard.ts
writeRawStdout() is a thin wrapper around process.stdout.write with no redaction.

---

## 3. TUI (Interactive Mode)

### packages/coding-agent/src/core/tools/render-utils.ts
getTextOutput() extracts text from tool result content blocks using sanitizeBinaryOutput but does NOT call safe() or redactNoise(). Any JSON body with a sensitive key name leaks.

### packages/coding-agent/src/modes/interactive/components/code-cell.ts
renderOutput() calls renderOutputText() with raw details.stdout, details.stderr, and details.result strings without redaction. Lines 566-591 handle output rendering.

### packages/coding-agent/src/modes/interactive/components/tool-execution.ts
getTextOutput() delegates to render-utils.ts getRenderedTextOutput() without redaction. Line 207-211: raw tool output rendered directly.

### packages/coding-agent/src/modes/interactive/components/assistant-message.ts
Renders raw content.text and content.thinking strings directly into the TUI without redaction. Lines 276-282 and 283-319 handle text and thinking blocks.

### packages/coding-agent/src/modes/interactive/components/bash-execution.ts
appendOutput() and updateDisplay() render raw shell output without calling redactNoise(). Line 71 appends raw chunks; lines 130-136 render without redaction.

---

## 4. Notch / Electron Surface

### packages/rlm-iris/src/index.ts
The iris() method returns task objects including result fields. The slash command handler at line 27-28 formats this as JSON and sends it to ctx.showMessage() without calling safe(). A result containing { "token": "sk-..." } is displayed verbatim.

---

## 5. Intermediate Storage

### packages/coding-agent/src/core/tools/output-accumulator.ts
OutputAccumulator stores raw streaming output in memory and disk without calling safe() or redactNoise().

---

## Summary Table

| Surface | File | Missing Call |
|---|---|---|
| HTML transcript export | coding-agent/src/core/export-html/index.ts | safe(), redactNoise() |
| HTML tool renderer | coding-agent/src/core/export-html/tool-renderer.ts | safe(), redactNoise() |
| CLI print mode | coding-agent/src/modes/print-mode.ts | safe(), redactNoise() |
| TUI text extractor | coding-agent/src/core/tools/render-utils.ts | safe(), redactNoise() |
| TUI code cell output | coding-agent/src/modes/interactive/components/code-cell.ts | safe(), redactNoise() |
| TUI tool execution | coding-agent/src/modes/interactive/components/tool-execution.ts | safe(), redactNoise() |
| TUI assistant message | coding-agent/src/modes/interactive/components/assistant-message.ts | safe(), redactNoise() |
| TUI bash execution | coding-agent/src/modes/interactive/components/bash-execution.ts | redactNoise() |
| Notch/Electron (iris) | rlm-iris/src/index.ts | safe() |
| Intermediate storage | coding-agent/src/core/tools/output-accumulator.ts | safe(), redactNoise() |

All 10 surfaces listed above need at least one of safe() (for structured/object output) or redactNoise() (for free-text/string output) applied before the content reaches the user.
