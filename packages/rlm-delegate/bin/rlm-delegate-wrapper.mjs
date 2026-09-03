#!/usr/bin/env node
/*
 * rlm-delegate-wrapper.mjs
 * 
 * Wrapper that spawns the real rlm-delegate process and forwards commands.
 * Used by Iris to spawn rlm-delegate as a child process.
 */

import { exec, execSync } from 'child_process';
import { join } from 'path';
import * as fs from 'fs';

// Find the rlm-delegate entry point
const findRlmDelegate = () => {
  const rlmHome = process.env.RLM_HOME || join(process.env.HOME || "/", ".rlm");
  const delegatePath = join(rlmHome, "agent", "workflows", "delegator.ts");
  
  // If the file exists, use it as the entry point
  if (fs.existsSync(delegatePath)) {
    return { type: "ts", path: delegatePath };
  }
  
  // Otherwise use the built-in entry from rlm-delegate package
  try {
    const pkgPath = require.resolve('rlm-delegate/package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    return { type: "js", path: pkg.main || pkg.module };
  } catch (e) {
    // Fallback to node process
    return { type: "node", path: process.execPath };
  }
};

const delegateInfo = findRlmDelegate();

// Spawn the delegate process
const spawnDelegate = () => {
  const env = {
    ...process.env,
    RLM_DELEGATE_WRAPPER: "1",
    RLM_EXECUTOR: "rlm-delegate",
    RLM_HOME: process.env.RLM_HOME || join(process.env.HOME || "/", ".rlm"),
  };
  
  const args = delegateInfo.type === "ts" 
    ? ["--import", "tsx", delegateInfo.path]
    : delegateInfo.type === "js" 
    ? [delegateInfo.path]
    : [];
  
  const child = exec(
    delegateInfo.type === "node" ? process.execPath : "node",
    [...args, ...process.argv.slice(2)],
    {
      stdio: ["pipe", "pipe", "inherit"],
      detached: false,
      env,
    }
  );
  
  // Forward output
  child.stdout.on('data', (data) => {
    process.stdout.write(data);
  });
  child.stderr.on('data', (data) => {
    process.stderr.write(data);
  });
  
  return child;
};

const delegateChild = spawnDelegate();

// Handle signals to kill child
const cleanup = () => {
  delegateChild.kill('SIGTERM');
  setTimeout(() => {
    if (delegateChild.exitCode === null) {
      delegateChild.kill('SIGKILL');
    }
  }, 2000);
};

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

// Keep the wrapper alive as long as the child is running
delegateChild.on('exit', (code, signal) => {
  if (signal) {
    console.error('rlm-delegate wrapper exited with signal:', signal);
    process.exit(1);
  }
  process.exit(code ?? 0);
});
