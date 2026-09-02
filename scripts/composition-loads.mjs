#!/usr/bin/env node
/**
 * Every row in the composition can actually be imported.
 *
 * Cordis already protects a *running* process: on a failed update the loader
 * rolls back to the previous entry and only throws if the rollback itself
 * fails. That is why the drive kept working twice tonight while every `rlm`
 * command was returning a stack trace — the daemon had its old modules, and a
 * cold boot had nothing to fall back to.
 *
 * A cold boot cannot roll back to something it never loaded, so the protection
 * has to come earlier: refuse to be surprised. This imports each row's entry
 * the way the loader would and reports the ones that will not load.
 *
 * Both of tonight's outages die here:
 *   - `rlm-outloop` mounted as a row while being a contract with no default
 *     export — "invalid plugin, expect function or object with an apply method"
 *   - a stray `}` in `rlm-sdk/src/index.ts:262` — "Expected identifier but
 *     found !"
 * Neither was detectable from the outside: the journal advanced, children
 * spawned, and every liveness signal stayed green.
 *
 *   node scripts/composition-loads.mjs [path/to/cordis.yml]
 *
 * Exits non-zero, and names the row, when something will not load.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const file = resolve(process.argv[2] ?? 'cordis.yml')
const root = dirname(file)

// Deliberately not a YAML parser. The rows this needs are two flat keys, and a
// dependency here is a dependency in the thing that checks the dependencies.
const rows = []
let current = null
for (const raw of readFileSync(file, 'utf8').split('\n')) {
  const line = raw.replace(/#.*$/, '')
  const id = line.match(/^-\s*id:\s*(\S+)/)
  if (id) {
    if (current) rows.push(current)
    current = { id: id[1], name: null }
    continue
  }
  const name = line.match(/^\s+name:\s*['"]?([^'"\s]+)['"]?/)
  if (name && current && !current.name) current.name = name[1]
}
if (current) rows.push(current)

const seen = new Map()
const problems = []

for (const row of rows) {
  if (seen.has(row.id)) {
    problems.push({ id: row.id, why: `declared twice — the loader refuses the whole composition on a duplicate id` })
    continue
  }
  seen.set(row.id, row)
  if (!row.name) continue
  // Only local rows. A package from node_modules is the package manager's
  // problem and importing every one of them would make this slow enough to
  // skip, which is the same as not having it.
  if (!row.name.startsWith('.')) continue

  const target = resolve(root, row.name)
  try {
    const mod = await import(pathToFileURL(target).href)
    const plugin = mod.default ?? mod
    const usable = typeof plugin === 'function' || (plugin && typeof plugin.apply === 'function')
    if (!usable) {
      problems.push({
        id: row.id,
        why: `imports, but is not a plugin — Cordis wants a function or an object with an "apply" method, and this exports ${typeof plugin}`,
      })
    }
  } catch (error) {
    problems.push({ id: row.id, why: String(error?.message ?? error).split('\n')[0].slice(0, 200) })
  }
}

for (const p of problems) {
  console.log(`  ${p.id}`)
  console.log(`      ${p.why}`)
}
console.log(`\n${problems.length} of ${rows.length} row(s) will not load`)
process.exit(problems.length ? 1 : 0)
