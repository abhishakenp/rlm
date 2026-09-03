#!/usr/bin/env node
import { derive } from "./packages/rlm-delegate/src/derive.ts";
console.log('derive imported:', !!derive);
console.log('Derived test:', derive('test request', { cwd: process.cwd() })?.proof.kind);
