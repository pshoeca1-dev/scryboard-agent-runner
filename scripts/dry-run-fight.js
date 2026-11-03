// Offline check of the client's fight and dice calls: a fake fetch, no network.
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

  // Dice: asking for a roll, and a dice app's four calls.
  const sent = async (fn, data) => {
    calls.length = 0
    reply = { status: 200, body: { data } }
    const out = await fn()
    assert.deepEqual(out, data)
    return { url: calls[0].url, method: calls[0].opts.method, body: calls[0].opts.body ? JSON.parse(calls[0].opts.body) : null, auth: calls[0].opts.headers.Authorization }
  }
  const REQUESTS = 'http://scry.test/api/agent/dice/requests'

  let call = await sent(() => client.dice.roll('1d20+4', { label: 'Goblin: Scimitar' }), { total: 17 })
  assert.deepEqual([call.url, call.method, call.body], ['http://scry.test/api/agent/dice', 'POST', { notation: '1d20+4', label: 'Goblin: Scimitar' }])
  assert.equal(call.auth, 'Bearer scry_tok')

  call = await sent(() => client.dice.pending(), [{ id: 'r1' }])
  assert.equal(call.url, REQUESTS)
  assert.equal(call.body, null)

  call = await sent(() => client.dice.claim('r1'), true)
  assert.deepEqual([call.url, call.body], [REQUESTS, { id: 'r1', action: 'claim' }])

  call = await sent(() => client.dice.answer('r1', [13]), true)
  assert.deepEqual([call.url, call.body], [REQUESTS, { id: 'r1', action: 'answer', values: [13] }])

  call = await sent(() => client.dice.decline('r1'), true)
  assert.deepEqual([call.url, call.body], [REQUESTS, { id: 'r1', action: 'decline' }])

  // A claim that's refused must come back as false, not get lost.
  assert.equal(await sent(() => client.dice.claim('r2'), false).then(() => true), true)

  console.log('fight and dice dry run: all checks passed')
}

main()
