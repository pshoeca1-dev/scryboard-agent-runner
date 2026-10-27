// Dry run for 0.2.15's problem reporting, no Electron window needed:
//   node scripts/dry-run-problems.js
// Runs a throwaway app whose tick always throws, against a pretend
// Scryboard on this computer, and checks what reaches /api/agent/problems:
// one report for three failed runs in a row, a second for a different
// message, and nothing when the tick succeeds or Scryboard can't be reached.

const http = require('node:http')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const Module = require('node:module')

// agent-runner.js -> store.js needs Electron; a local-folder app never uses it.
const realLoad = Module._load
Module._load = function (request, ...rest) {
  if (request === 'electron') return { app: { getPath: () => os.tmpdir() }, safeStorage: {} }
  return realLoad.call(this, request, ...rest)
}
const { AgentManager } = require('../agent-runner')
const { createProblemReporter, REPEAT_GAP_MS } = require('../problem-reporter')

async function main() {
  const posts = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json')
      if (req.method === 'POST' && req.url === '/api/agent/problems') {
        posts.push({ auth: req.headers.authorization, body: JSON.parse(body) })
        res.end(JSON.stringify({ data: { recorded: true } }))
      } else if (req.url.startsWith('/api/agent/sessions')) {
        res.end(JSON.stringify({ data: [] }))
      } else {
        res.statusCode = 404
        res.end(JSON.stringify({ error: 'not found' }))
      }
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const baseUrl = `http://127.0.0.1:${server.address().port}`

  const appDir = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-problems-'))
  await fs.writeFile(path.join(appDir, 'scryboard.json'), JSON.stringify({ name: 'Crashy', entry: 'agent.mjs' }))
  const writeTick = (code) => fs.writeFile(path.join(appDir, 'agent.mjs'), `export async function tick() { ${code} }\n`)

  const manager = new AgentManager()
  manager.records = [{ id: 'app1', name: 'Crashy', entry: 'agent.mjs', localPath: appDir, baseUrl }]
  manager.tokens.set('app1', 'sbat_test_token')
  const run = async () => {
    await manager.runTickOnce('app1', manager.records[0])
    clearTimeout(manager.timers.get('app1'))
    await new Promise((r) => setTimeout(r, 150)) // let the fire-and-forget POST land
  }

  await writeTick(`throw new Error('Kanka said no: ' + 'x'.repeat(600))`)
  await run(); await run(); await run()
  assert.equal(posts.length, 1, 'three identical failures -> one report')
  assert.equal(posts[0].auth, 'Bearer sbat_test_token')
  assert.equal(posts[0].body.where, 'tick')
  assert.equal(posts[0].body.message.length, 500, 'message capped at 500 characters')
  assert.ok(posts[0].body.message.startsWith('Kanka said no: '))
  assert.deepEqual(Object.keys(posts[0].body).sort(), ['message', 'where'], 'nothing else is sent')
  assert.equal(manager.records[0].status, 'error', 'the Runner window still shows the error')

  await new Promise((r) => setTimeout(r, 20)) // new mtime so the edited module reloads
  await writeTick(`throw new Error('a different failure')`)
  await run()
  assert.equal(posts.length, 2, 'a different message is reported')
  assert.equal(posts[1].body.message, 'a different failure')

  await new Promise((r) => setTimeout(r, 20))
  await writeTick(`return`)
  await run()
  assert.equal(posts.length, 2, 'a good run reports nothing')
  assert.equal(manager.records[0].status, 'running')

  // Scryboard down: the app's "fetch failed" isn't reported (it couldn't arrive).
  server.close()
  await new Promise((r) => setTimeout(r, 20))
  await writeTick(`await fetch('${baseUrl}/anything')`)
  await run()
  assert.equal(posts.length, 2, 'nothing reported while Scryboard is unreachable')

  // Throttle over time, and a reporter whose send blows up never throws.
  let clock = 0
  const sent = []
  const reporter = createProblemReporter({ fetchImpl: async (url, init) => { sent.push(init.body); throw new Error('offline') }, now: () => clock })
  const one = { appId: 'a', token: 't', baseUrl: 'http://x/', message: 'boom' }
  assert.equal(reporter.report(one), true)
  clock += REPEAT_GAP_MS - 1
  assert.equal(reporter.report(one), false, 'same message within a minute is skipped')
  assert.equal(reporter.report({ ...one, appId: 'b' }), true, 'per app, not global')
  clock += 1
  assert.equal(reporter.report(one), true, 'again after a minute')
  assert.equal(reporter.report({ ...one, message: '   ' }), false, 'empty message skipped')
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(sent.length, 3)

  await fs.rm(appDir, { recursive: true, force: true })
  console.log('OK: a thrown tick was reported once; repeats, good runs and unreachable Scryboard sent nothing extra.')
  console.log('Sent body:', JSON.stringify({ ...posts[0].body, message: posts[0].body.message.slice(0, 40) + '…' }))
}

main().catch((err) => { console.error(err); process.exit(1) })
