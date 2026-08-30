# rlm-code

Persistent JavaScript code execution tool for [rlm](https://github.com/abhishakenp/rlm). Cordis Service. No Python.

## What it does

- `!command` → shell out (line magic)
- `%%bash` cell → multi-line shell block
- Persistent variables across calls (`vm.Context` = kernel namespace)
- `console.log()` output captured as stdout
- Last expression value captured as result
- `rlm.run()` for in-process subagent spawning
- `fs`, `path`, `os`, `child_process`, `fetch`, `import()` all available

## Install

```bash
npm install rlm-code
```

## Usage

This is a Cordis plugin used by `rlm`. It's not standalone — it provides the `rlmCode` service to the rlm host.

```yaml
# config/profile.yml
- id: code
  name: 'rlm-code/src/index.ts'
  config:
    timeout: 60000
    maxOutputChars: 65536
```

## Code tool interface

The code tool accepts a single `code` string and returns:

```typescript
{
  stdout: string;
  stderr: string;
  result?: string;   // last expression value
  status: "ok" | "error";
  durationMs: number;
}
```

### Shell commands

```
!ls -la
!git status
```

### Multi-line shell

```
%%bash
cd ./src
grep -r "TODO" .
```

### JavaScript

```javascript
const fs = require("fs");
const files = fs.readdirSync(".");
console.log(files);
```

## License

MIT
