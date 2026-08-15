// Media playback for agents (the `plays_audio` capability) -- the "one
// vetted, cross-platform player shipped inside the Runner" that lets an
// app make sound without ever touching an audio device, a child process,
// or a native binding itself.
//
// The player is Chromium. This Electron app already ships a browser
// engine that decodes MP3/WAV/OGG (and video, for that matter) natively,
// so playback happens in a hidden BrowserWindow loading playback.html:
// bytes go in over IPC, an <audio> element plays them, ended/error comes
// back. No new dependencies, nothing platform-specific.
//
// Media-agnostic on purpose (a hard requirement of this design): every
// seam here is keyed by media type through the MEDIA_TYPES table --
// capability string, element tag, accepted content types, and which kind
// of window playback needs. Audio is the only entry today. Video later is
// a new table entry whose `window: 'visible'` routes to a visible window,
// plus its own `plays_video` capability -- no rework of the envelope, the
// IPC, or the callers.
//
// Policy: ONE thing plays at a time, globally. Two apps layering audio
// over each other at a live table is chaos nobody asked for -- a new play
// (from any app) replaces whatever is currently playing, and the main
// window always shows what's playing, from which app, with a Stop button.
// Mixing/ducking is explicitly future work (see Scryboard's BACKLOG row
// on Syrinscape-style coordination).

const { BrowserWindow } = require('electron')
const path = require('node:path')

const MEDIA_TYPES = {
  audio: {
    capability: 'plays_audio',
    element: 'audio',
    window: 'hidden',
    contentTypes: new Set([
      'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/ogg',
      'audio/webm', 'audio/mp4', 'audio/aac', 'audio/flac',
    ]),
  },
  // video: { capability: 'plays_video', element: 'video', window: 'visible', contentTypes: new Set([...]) }
}

// IPC payload ceiling. Recap-length audio is a few MB; even a long
// high-bitrate track fits comfortably. Protects the IPC channel, not the
// disk.
const MAX_MEDIA_BYTES = 50 * 1024 * 1024

function mediaTypeOf(contentType) {
  const family = String(contentType || '').split('/')[0]
  return MEDIA_TYPES[family] ? { family, ...MEDIA_TYPES[family] } : null
}

class PlaybackManager {
  // onStatusChange receives the current status object (see status()) on
  // every transition -- main.js forwards it to the UI.
  constructor(onStatusChange) {
    this.onStatusChange = onStatusChange || (() => {})
    this.window = null
    this.current = null // { agentId, agentName, title, contentType, startedAt }
  }

  // The hidden window is created lazily on first play and reused after --
  // and recreated if something destroyed it (a crash, an OS cleanup).
  async ensureWindow() {
    if (this.window && !this.window.isDestroyed()) return this.window
    // Default (sandboxed) renderer: the page only ever receives bytes
    // from this process and plays them -- no remote content, no
    // navigation, and its preload needs nothing beyond contextBridge.
    this.window = new BrowserWindow({
      show: false,
      webPreferences: { preload: path.join(__dirname, 'playback-preload.js') },
    })
    this.window.on('closed', () => { this.window = null })
    await this.window.loadFile('playback.html')
    return this.window
  }

  // spec: { agentId, agentName, bytes (Buffer/Uint8Array), contentType,
  // title?, volume? }. Capability checking against the agent's declared
  // set happens in the client (which holds that set); this validates the
  // media itself and owns the single-slot policy.
  async play(spec) {
    const media = mediaTypeOf(spec.contentType)
    if (!media) {
      throw new Error(`Unsupported media type "${spec.contentType}" -- audio only for now`)
    }
    if (!media.contentTypes.has(String(spec.contentType).toLowerCase())) {
      throw new Error(`Unsupported ${media.family} format "${spec.contentType}"`)
    }
    if (!spec.bytes || spec.bytes.length === 0) {
      throw new Error('Nothing to play -- media bytes are empty')
    }
    if (spec.bytes.length > MAX_MEDIA_BYTES) {
      throw new Error(`Media too large to play (${Math.round(MAX_MEDIA_BYTES / 1024 / 1024)}MB max)`)
    }

    const volume = typeof spec.volume === 'number' ? Math.min(1, Math.max(0, spec.volume)) : 1

    const win = await this.ensureWindow()
    this.current = {
      agentId: spec.agentId,
      agentName: spec.agentName || 'an app',
      title: spec.title || null,
      contentType: spec.contentType,
      startedAt: Date.now(),
    }
    win.webContents.send('playback-play', {
      bytes: spec.bytes,
      contentType: spec.contentType,
      element: media.element,
      volume,
    })
    this.onStatusChange(this.status())
    return { playing: true }
  }

  // stop() stops everything; stop(agentId) only stops if that agent owns
  // the current playback -- so an app pausing/being removed can't cut off
  // a different app's track.
  stop(agentId) {
    if (agentId && this.current && this.current.agentId !== agentId) return
    if (this.window && !this.window.isDestroyed()) {
      this.window.webContents.send('playback-stop')
    }
    this.current = null
    this.onStatusChange(this.status())
  }

  // Called by main.js when the playback page reports its element finished
  // or failed.
  handlePageEvent(event, detail) {
    if (event === 'ended') {
      this.current = null
      this.onStatusChange(this.status())
    } else if (event === 'error') {
      const who = this.current?.agentName
      this.current = null
      this.onStatusChange({ ...this.status(), lastError: `${who ? who + ': ' : ''}${detail || 'playback failed'}` })
    }
  }

  status() {
    return this.current
      ? { playing: true, agentId: this.current.agentId, agentName: this.current.agentName, title: this.current.title }
      : { playing: false }
  }

  destroy() {
    if (this.window && !this.window.isDestroyed()) this.window.destroy()
    this.window = null
    this.current = null
  }
}

module.exports = { PlaybackManager, MEDIA_TYPES, MAX_MEDIA_BYTES }
