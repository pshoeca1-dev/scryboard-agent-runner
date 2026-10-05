// Listens for "run this app now" nudges from Scryboard (Runner 0.2.7).
//
// An app here runs on a timer -- every 20 seconds to several minutes -- and
// only then reads the buttons a DM clicked or the settings box they saved.
// So a click looked like it did nothing for up to a minute. Scryboard now
// sends a tiny Realtime Broadcast when one of this app's buttons is clicked
// or one of its settings is saved, and this listener turns it into an
// immediate tick (see AgentManager.wake in agent-runner.js).
//
// What it trusts: nothing. The message carries only the word "wake" -- no
// click, no value -- so the worst a forged or replayed nudge can do is run
// the app's tick early, which the manager rate-limits. The app still reads
// everything through its own token and scopes, exactly as on a timer.
//
// What it costs when it fails: nothing new. A server too old to have the
// wake channel (404), Realtime being unreachable, a dropped connection --
// every failure just leaves the app on its normal timer, and this keeps
// trying to reconnect in the background with growing gaps.
//
// Speaks Supabase Realtime's Phoenix protocol directly over `ws` (Electron
// 33's Node has no built-in WebSocket) rather than pulling in supabase-js:
// join one public broadcast topic, heartbeat, rejoin on drop.

const WebSocket = require('ws')

const HEARTBEAT_MS = 25 * 1000
const MIN_RETRY_MS = 2 * 1000
const MAX_RETRY_MS = 5 * 60 * 1000
// A server that has never heard of the wake channel won't grow one in the
// next few seconds; ask again much later, in case Scryboard was updated.
const NOT_SUPPORTED_RETRY_MS = 60 * 60 * 1000

class WakeListener {
  // fetchChannel: async () => ({ realtime_url, apikey, topic, event }),
  //   or throws an Error with `.status` (404 means "server too old").
  // onWake: () => void
  constructor({ fetchChannel, onWake }) {
    this.fetchChannel = fetchChannel
    this.onWake = onWake
    this.ws = null
    this.heartbeat = null
    this.retryTimer = null
    this.retryMs = MIN_RETRY_MS
    this.ref = 0
    this.stopped = false
    this.connected = false
  }

  start() {
    this.stopped = false
    this.connect()
  }

  stop() {
    this.stopped = true
    clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.teardown()
  }

  teardown() {
    clearInterval(this.heartbeat)
    this.heartbeat = null
    this.connected = false
    const ws = this.ws
    this.ws = null
    if (ws) {
      ws.removeAllListeners()
      ws.on('error', () => {}) // a close racing an error must not crash the process
      try { ws.terminate() } catch { /* already gone */ }
    }
  }

  scheduleRetry(ms) {
    if (this.stopped) return
    clearTimeout(this.retryTimer)
    this.retryTimer = setTimeout(() => this.connect(), ms)
    this.retryMs = Math.min(this.retryMs * 2, MAX_RETRY_MS)
  }

  async connect() {
    if (this.stopped) return
    this.teardown()

    let channel
    try {
      channel = await this.fetchChannel()
    } catch (err) {
      this.scheduleRetry(err?.status === 404 ? NOT_SUPPORTED_RETRY_MS : this.retryMs)
      return
    }
    if (this.stopped) return
    if (!channel?.realtime_url || !channel?.apikey || !channel?.topic) {
      this.scheduleRetry(NOT_SUPPORTED_RETRY_MS)
      return
    }

    const event = channel.event || 'wake'
    const topic = `realtime:${channel.topic}`
    const url = `${channel.realtime_url}?apikey=${encodeURIComponent(channel.apikey)}&vsn=1.0.0`
    const ws = new WebSocket(url)
    this.ws = ws
    const send = (t, ev, payload) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ topic: t, event: ev, payload, ref: String(++this.ref) }))
      }
    }

    ws.on('open', () => {
      send(topic, 'phx_join', {
        config: { broadcast: { self: false, ack: false }, presence: { key: '' }, postgres_changes: [], private: false },
      })
      this.heartbeat = setInterval(() => send('phoenix', 'heartbeat', {}), HEARTBEAT_MS)
    })

    ws.on('message', (raw) => {
      let msg
      try { msg = JSON.parse(String(raw)) } catch { return }
      if (msg.topic !== topic) return
      if (msg.event === 'phx_reply' && msg.payload?.status === 'ok' && !this.connected) {
        this.connected = true
        this.retryMs = MIN_RETRY_MS // a good connection resets the backoff
        return
      }
      if (msg.event === 'phx_reply' && msg.payload?.status === 'error') {
        this.teardown()
        this.scheduleRetry(this.retryMs)
        return
      }
      if (msg.event === 'broadcast' && msg.payload?.event === event) {
        try { this.onWake() } catch { /* the manager's problem, never the socket's */ }
      }
      if (msg.event === 'phx_close' || msg.event === 'phx_error') {
        this.teardown()
        this.scheduleRetry(this.retryMs)
      }
    })

    ws.on('error', () => {
      // 'close' always follows; reconnect from there.
    })
    ws.on('close', () => {
      if (this.ws !== ws) return // replaced or stopped on purpose
      this.teardown()
      this.scheduleRetry(this.retryMs)
    })
  }
}

module.exports = { WakeListener }
