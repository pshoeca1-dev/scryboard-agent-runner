// Tells Scryboard when an app's tick fails, so the developer sees it under
// that app's Recent problems on Your Apps (0.2.15) -- the same list a
// browser app's crashes already reach from the page running it. Before,
// a node_cli app's errors only ever showed in this window's status line,
// on the buyer's computer, where the developer never saw them.
//
// Sends only the error text the app's own run produced (and where it
// happened), with that app's own token -- nothing else from the app or
// the campaign. Fire and forget: report() never throws, never makes the
// tick wait, and a failed send is simply dropped.

// The server keeps 500 characters of a message; don't send more.
const MAX_MESSAGE = 500
// One app failing the same way every 30-second tick is one problem, not
// 120 an hour: the same message from the same app goes at most this often.
// (The server counts repeats, so the count still climbs, just in steps.)
const REPEAT_GAP_MS = 60 * 1000
// Give up on a send after this long rather than leave it hanging.
const SEND_TIMEOUT_MS = 10 * 1000
// Forget the oldest remembered messages past this many, so an app whose
// error text changes every run (a timestamp in it) can't grow memory forever.
const MAX_REMEMBERED = 200

function createProblemReporter({ fetchImpl = (...args) => fetch(...args), now = () => Date.now() } = {}) {
  const lastSent = new Map() // `${appId}\n${message}` -> ms it was last sent

  function report({ appId, token, baseUrl, message, where = 'tick' }) {
    try {
      const text = String(message ?? '').trim().slice(0, MAX_MESSAGE)
      if (!text || !token || !baseUrl) return false
      const key = `${appId}\n${text}`
      const at = now()
      const previous = lastSent.get(key)
      if (previous !== undefined && at - previous < REPEAT_GAP_MS) return false
      lastSent.delete(key) // re-insert so the Map's order stays oldest-first
      lastSent.set(key, at)
      while (lastSent.size > MAX_REMEMBERED) lastSent.delete(lastSent.keys().next().value)

      Promise.resolve()
        .then(() => fetchImpl(`${String(baseUrl).replace(/\/+$/, '')}/api/agent/problems`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: text, where: String(where).slice(0, 120) }),
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        }))
        .catch(() => {})
      return true
    } catch {
      return false
    }
  }

  // An app removed (or its token replaced) starts with a clean slate.
  function forget(appId) {
    for (const key of lastSent.keys()) if (key.startsWith(`${appId}\n`)) lastSent.delete(key)
  }

  return { report, forget }
}

module.exports = { createProblemReporter, MAX_MESSAGE, REPEAT_GAP_MS }
