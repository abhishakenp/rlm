#!/usr/bin/env bun
// `rlm-olympus <stage>` without rlm — the same dispatch the `olympus` mode runs.
import { runOlympus } from "../src/cli.ts";

process.exit(await runOlympus(process.argv.slice(2)));
