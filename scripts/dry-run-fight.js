// Offline check of the client's fight.act: a fake fetch, no network.
//
//   node scripts/dry-run-fight.js

const assert = require('node:assert/strict')
const { createClient } = require('../scryboard-client')

async function main() {
  const calls = []
  let reply = { status: 200, body: { data: { event_id: 'e1', combatant: { id: 'c1', initiative: 16 } } } }
  global.fetch = async (url, opts) => {
    calls.push({ url, opts })
    return { ok: reply.status < 400, status: reply.status, json: async () => reply.body }
  }

  const client = createClient({ token: 'scry_tok', baseUrl: 'http://scry.test' })
  const action = { type: 'set', target: 'c1', initiative: 16 }

  const result = await client.fight.act('s1', action)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'http://scry.test/api/agent/fight')
  assert.equal(calls[0].opts.method, 'POST')
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer scry_tok')
  assert.equal(calls[0].opts.headers['Content-Type'], 'application/json')
  assert.deepEqual(JSON.parse(calls[0].opts.body), { session_id: 's1', action })
  assert.equal(result.event_id, 'e1')

  // A refusal reaches the app with Scryboard's own words.
  reply = { status: 403, body: { error: 'This app did not declare the combat write scope' } }
  await assert.rejects(client.fight.act('s1', action), /did not declare the combat write scope \(HTTP 403\)/)

  console.log('fight.act dry run: all checks passed')
}

main()
