// A Node module customization hook (registered once at startup via
// node:module's register() in main.js) that keys every local file:// module
// by its OWN on-disk mtime, not just whatever query string the caller
// happened to attach to the top-level import.
//
// Why this exists: runTick() in agent-runner.js cache-busts an agent's
// reload by appending `?v=<newest mtime across the whole folder>` to the
// dynamic import() of its entry file only (agent.mjs). That works for the
// entry file itself, but ANY relative import inside it (e.g.
// `import { x } from './lib/y.mjs'`) resolves to a plain file:// URL with
// no query string -- and Node's ES module cache is keyed by exact URL,
// permanently, for the life of the process. The very first time any
// version of agent.mjs pulled in lib/y.mjs, THAT content got cached
// forever; editing lib/y.mjs afterward is invisible until the whole Runner
// process restarts, even though the entry file reloads correctly on every
// tick. Confirmed in the field 2026-08-14: a personal agent's lib file was
// edited to add a new export, the entry file's own updated import
// statement referenced it correctly, and the tick still failed with
// "does not provide an export named ..." -- the entry file was fresh, its
// dependency wasn't.
//
// Fix: give every local file its own independent, always-correct cache
// key derived from its own mtime, rather than relying on a single
// version stamp propagating through the whole import graph (it doesn't --
// query strings on a base URL are dropped when resolving a relative
// specifier against it, this isn't Runner-specific behavior).

import { statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export async function resolve(specifier, context, nextResolve) {
  const result = await nextResolve(specifier, context)
  if (!result.url.startsWith('file:') || result.url.includes('?v=')) return result
  try {
    const mtime = statSync(fileURLToPath(result.url)).mtimeMs
    return { ...result, url: `${result.url}?v=${mtime}` }
  } catch {
    return result // not a real file on disk -- leave resolution untouched
  }
}

export async function load(url, context, nextLoad) {
  // Strip the cache-busting query back off before actually reading the
  // file -- `?v=...` is a cache key, not part of the real path.
  const bare = url.includes('?v=') ? url.slice(0, url.indexOf('?v=')) : url
  return nextLoad(bare, context)
}
