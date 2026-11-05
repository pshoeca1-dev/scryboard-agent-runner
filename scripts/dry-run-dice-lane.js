// Dry run for 0.2.18's dice lane, no Electron window needed:
//   node scripts/dry-run-dice-lane.js
// Runs throwaway apps against a pretend Scryboard on this computer. The point
// is the two things that make the lane safe and useful: it doesn't wait behind
// another app's run, and it never sees another app's keys.

const http = require('node:http')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const Module = require('node:module')

// agent-runner.js -> store.js needs Electron; a local-folder app never uses it.
const realLoad = Module._load
Module._load = function (request, ...rest) {
  if (request === 'electron') return { app: { getPath: () => os.tmpdir() }, safeStorage: { isEncryptionAvailable: () => false } }
  return realLoad.call(this, request, ...rest)
}
const { AgentManager } = require('../agent-runner')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function main() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dice-lane-'))
  const counts = { pending: 0, active: 0 }
  let isChosen = true
  let sessionLive = true
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (req.url.startsWith('/api/agent/dice/active')) { counts.active++; return res.end(JSON.stringify({ data: isChosen })) }
    if (req.url.startsWith('/api/agent/dice/requests')) { counts.pending++; return res.end(JSON.stringify({ data: [] })) }
    if (req.url.startsWith('/api/agent/sessions')) return res.end(JSON.stringify({ data: sessionLive ? [{ id: 's1', status: 'active' }] : [] }))
    return res.end(JSON.stringify({ data: null }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${server.address().port}`

  // A slow app holding the one-at-a-time lock, and recording what it can see.
  const slowDir = path.join(dir, 'slow')
  await fs.mkdir(slowDir)
  await fs.writeFile(path.join(slowDir, 'agent.mjs'), `
    export async function tick() {
      globalThis.__slowTickRunning = true
      await new Promise((r) => setTimeout(r, globalThis.__slowTickMs ?? 0))
      globalThis.__slowTickRunning = false
    }`)

  // A dice app whose answerDice records what it was given and what it saw.
  const diceDir = path.join(dir, 'dice')
  await fs.mkdir(diceDir)
  await fs.writeFile(path.join(diceDir, 'agent.mjs'), `
    export async function tick(scryboard) {
      globalThis.__diceTicks = (globalThis.__diceTicks ?? 0) + 1
      globalThis.__tickSawLane = scryboard.dice.lane
    }
    export async function answerDice(scryboard, options) {
      globalThis.__laneCalls = (globalThis.__laneCalls ?? 0) + 1
      globalThis.__laneDuringSlowTick = globalThis.__laneDuringSlowTick || globalThis.__slowTickRunning
      globalThis.__laneSecrets = options.secrets
      await scryboard.dice.pending()
      if (globalThis.__laneDelayMs) await new Promise((r) => setTimeout(r, globalThis.__laneDelayMs))
      globalThis.__laneFinished = (globalThis.__laneFinished ?? 0) + 1
    }`)

  // An app with no answerDice, and one that isn't a dice app at all.
  const plainDir = path.join(dir, 'plain')
  await fs.mkdir(plainDir)
  await fs.writeFile(path.join(plainDir, 'agent.mjs'), `
    export async function tick() {}
    export async function answerDice() { globalThis.__plainLane = true }`)

  const manager = new AgentManager()
  const record = (id, localPath, provides) => ({ id, name: id, entry: 'agent.mjs', localPath, baseUrl, enabled: true, provides, poll: { activeSeconds: 600, idleSeconds: 600 } })
  manager.records = [record('slow', slowDir, []), record('dice', diceDir, ['dice']), record('plain', plainDir, [])]
  manager.tokens.set('slow', 't-slow')
  manager.tokens.set('dice', 't-dice')
  manager.tokens.set('plain', 't-plain')
  manager.secrets.set('slow', { SLOW_KEY: 'slow-secret' })
  manager.secrets.set('dice', { DICE_KEY: 'dice-secret' })
  manager.allSecretKeys = new Set(['SLOW_KEY', 'DICE_KEY'])
  manager.persist = async () => {}

  // 1. It doesn't wait behind another app's run.
  globalThis.__slowTickMs = 1500
  const slowRun = manager.runTick('slow')
  while (!globalThis.__slowTickRunning) await sleep(10)
  assert.equal(process.env.SLOW_KEY, 'slow-secret', 'the slow app is mid-run, with its key stamped')
  const startedAt = Date.now()
  await manager.runDiceLane('dice')
  assert.ok(Date.now() - startedAt < 1000, `answered in ${Date.now() - startedAt} ms, not after the other app's run`)
  assert.equal(globalThis.__laneDuringSlowTick, true)

  // 2. It gets its own keys as an argument, a copy, and touches no one's env.
  assert.deepEqual(globalThis.__laneSecrets, { DICE_KEY: 'dice-secret' })
  assert.equal(process.env.DICE_KEY, undefined, "the lane never stamps its key into the shared environment")
  assert.equal(process.env.SLOW_KEY, 'slow-secret', "and doesn't disturb the other app's")
  globalThis.__laneSecrets.DICE_KEY = 'changed'
  assert.equal(manager.secrets.get('dice').DICE_KEY, 'dice-secret', 'a copy, so an app cannot change what is stored')
  await slowRun
  assert.equal(process.env.SLOW_KEY, undefined)

  // 3. Overlapping calls: one at a time per app, and a nudge during one runs it again.
  globalThis.__laneDelayMs = 200
  globalThis.__laneCalls = 0
  globalThis.__laneFinished = 0
  const first = manager.runDiceLane('dice')
  await sleep(50)
  manager.runDiceLane('dice')
  manager.runDiceLane('dice')
  assert.equal(globalThis.__laneCalls, 1, 'one at a time')
  await first
  while (manager.diceBusy.has('dice')) await sleep(10)
  assert.equal(globalThis.__laneCalls, 2, 'nudged during it: exactly one more')
  globalThis.__laneDelayMs = 0

  // 4. Only for an app that declares it.
  await manager.runDiceLane('plain')
  assert.equal(globalThis.__plainLane, undefined, 'not a dice app: never called')

  // 5. A tick tells the app there's a lane, notes the live session, and checks in.
  globalThis.__laneCalls = 0
  await manager.runTick('dice')
  while (manager.diceBusy.has('dice')) await sleep(10)
  assert.equal(globalThis.__tickSawLane, true)
  assert.equal(manager.diceLive.has('dice'), true)
  assert.equal(globalThis.__laneCalls, 1, 'a check-in on each tick')

  // 6. The timer: chosen and live gets checked; anything else doesn't.
  const lanes = async () => {
    globalThis.__laneCalls = 0
    manager.diceCheck()
    await sleep(100)
    while (manager.diceBusy.has('dice')) await sleep(10)
    return globalThis.__laneCalls
  }
  manager.diceRoleAt.clear()
  manager.diceChosen.clear()
  counts.active = 0
  assert.equal(await lanes(), 0, 'the first check asks, and only then starts')
  assert.equal(counts.active, 1)
  assert.equal(manager.diceChosen.get('dice'), true)
  assert.equal(await lanes(), 1, 'chosen and live: checked')
  assert.equal(counts.active, 1, 'asks about once a minute, not every check')

  manager.diceRoleAt.delete('dice')
  isChosen = false
  await lanes()
  assert.equal(await lanes(), 0, 'not the chosen app: not checked')

  // A nudge asks again, so switching it on doesn't wait a minute.
  isChosen = true
  manager.wake = () => {}
  manager.nudged('dice')
  while (manager.diceBusy.has('dice')) await sleep(10)
  assert.equal(manager.diceRoleAt.has('dice'), false)
  await lanes()
  assert.equal(await lanes(), 1, 'nudged: chosen again')

  manager.diceLive.delete('dice')
  assert.equal(await lanes(), 0, 'no live session: not checked')
  manager.diceLive.add('dice')
  manager.records.find((r) => r.id === 'dice').enabled = false
  assert.equal(await lanes(), 0, 'paused: not checked')
  await manager.runDiceLane('dice')
  assert.equal(globalThis.__laneCalls, 0, 'paused: a nudge does nothing either')

  for (const id of ['slow', 'dice', 'plain']) {
    manager.stopped.add(id)
    clearTimeout(manager.timers.get(id))
  }
  clearInterval(manager.diceTimer)
  server.close()
  await fs.rm(dir, { recursive: true, force: true })
  console.log('dice lane dry run: all checks passed')
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
