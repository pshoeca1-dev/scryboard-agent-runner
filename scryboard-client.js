// The Scryboard client handed to an agent's tick(scryboard) function.
//
// Deliberately NOT a copy-paste of agent-runtime/scryboard.mjs (the
// version developers test against locally) -- that one reads its token
// from an environment variable, which is fine for running one agent by
// hand, but the runner will eventually run several agents at once, each
// with its own token, in the same process. This is a factory instead:
// call it once per agent with that agent's own token, get back a client
// bound to just that agent.
//
// Same method surface as agent-runtime/scryboard.mjs and the sandbox's
// version in src/lib/agentSandbox.ts, so an agent's tick() function reads
// identically regardless of which of the three actually runs it.

function createClient({ token, baseUrl }) {
  async function request(path, options = {}) {
    const res = await fetch(`${baseUrl}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...options.headers,
      },
    })

    let body
    try {
      body = await res.json()
    } catch {
      throw new Error(`Scryboard returned a non-JSON response (HTTP ${res.status})`)
    }

    if (!res.ok) {
      throw new Error(body.error ? `${body.error} (HTTP ${res.status})` : `Request failed (HTTP ${res.status})`)
    }

    return body.data
  }

  async function get(resource, params = {}) {
    const search = new URLSearchParams()
    for (const [key, value] of Object.entries(params)) {
      if (value != null) search.set(key, String(value))
    }
    const query = search.toString()
    return request(`/api/agent/${resource}${query ? `?${query}` : ''}`)
  }

  async function getActiveSession() {
    const sessions = await get('sessions')
    return sessions.find((s) => s.status === 'active') ?? null
  }

  async function pushWidget({ widget, layout, placement = 'session_dashboard', visibility = 'dm', session_id = null }) {
    if (!widget) throw new Error('pushWidget needs a `widget` name')
    if (!layout) throw new Error('pushWidget needs a `layout`')
    return request('/api/agent/widgets', {
      method: 'POST',
      body: JSON.stringify({ widget, layout, placement, visibility, session_id }),
    })
  }

  async function setCharacterData(category, data) {
    if (!category) throw new Error('setCharacterData needs a `category`')
    return request('/api/agent/character', {
      method: 'POST',
      body: JSON.stringify({ category, data }),
    })
  }

  async function updateCharacterData(category, updater, fallback = {}) {
    const character = await get('character')
    if (Array.isArray(character)) {
      throw new Error('Got every player\'s data back -- this needs a player-scope token, not a DM one.')
    }
    const current = character?.character_data?.[category] ?? fallback
    const next = await updater(current)
    await setCharacterData(category, next)
    return next
  }

  async function proposeExtractions(layer, items) {
    if (!layer) throw new Error('proposeExtractions needs a `layer`')
    if (!Array.isArray(items)) throw new Error('proposeExtractions needs an `items` array')
    return request('/api/agent/extractions', {
      method: 'POST',
      body: JSON.stringify({ layer, items }),
    })
  }

  async function uploadMedia({ data, alt = null }) {
    if (!data) throw new Error('uploadMedia needs `data` (Buffer or Uint8Array of image bytes)')
    const form = new FormData()
    form.set('file', new Blob([data]))
    if (alt) form.set('alt', alt)
    const res = await fetch(`${baseUrl}/api/agent/media`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    })
    let body
    try {
      body = await res.json()
    } catch {
      throw new Error(`Scryboard returned a non-JSON response (HTTP ${res.status})`)
    }
    if (!res.ok) {
      throw new Error(body.error ? `${body.error} (HTTP ${res.status})` : `Request failed (HTTP ${res.status})`)
    }
    return body.data
  }

  async function setMediaTier(mediaId, tier) {
    if (!mediaId) throw new Error('setMediaTier needs a `mediaId`')
    return request(`/api/agent/media/${mediaId}`, {
      method: 'PATCH',
      body: JSON.stringify({ tier }),
    })
  }

  async function setItemAttributes(layer, itemId, attributes) {
    if (!layer) throw new Error('setItemAttributes needs a `layer`')
    if (!itemId) throw new Error('setItemAttributes needs an `itemId`')
    return request('/api/agent/item-attributes', {
      method: 'POST',
      body: JSON.stringify({ layer, item_id: itemId, attributes }),
    })
  }

  async function getActions(params = {}) {
    return get('actions', params)
  }

  async function writeEvent({ event_type, payload, session_id = null, participants = [] }) {
    if (!event_type) throw new Error('writeEvent needs an `event_type`')
    if (!payload || typeof payload !== 'object') throw new Error('writeEvent needs a `payload` object')
    return request('/api/agent/events', {
      method: 'POST',
      body: JSON.stringify({ event_type, payload, session_id, participants }),
    })
  }

  async function getEvents(params = {}) {
    return get('events', params)
  }

  return {
    get,
    getActiveSession,
    pushWidget,
    setCharacterData,
    updateCharacterData,
    proposeExtractions,
    uploadMedia,
    setMediaTier,
    setItemAttributes,
    getActions,
    writeEvent,
    getEvents,
  }
}

module.exports = { createClient }
