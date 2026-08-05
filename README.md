# Scryboard Agent Runner — proof of concept

**Phase 1** proved the core mechanism: click a link, an agent downloads and
runs, without a terminal. **Confirmed working for real** — clicking "Run
with Scryboard Agent Runner" on a real listing page correctly hands off to
this app, no manual pasting required. The paste-it-by-hand box in the
window still exists as a convenience for testing, not because clicking is
unreliable.

**Phase 2** made it remember what's installed — in the app's own data
folder, token encrypted via the operating system's own credential storage,
not sitting in plain text — and keep ticking on its own schedule across
restarts, with no need to reinstall.

**Phase 3** made it actually backgroundable: a tray icon, and closing the
window no longer quits the app or stops any agent's ticking. Quitting is
now a deliberate choice from the tray menu, not an accident of closing a
window.

**Phase 4** (current) adds packages and secrets. An agent can now declare a
dependency on a small, fixed list of pre-approved libraries — bundled with
this app itself, nothing installed live on your machine per agent — and
can declare a required secret (an API key, say), which the runner prompts
for once at install time and stores the same secure way it already stores
your Scryboard token.

Still not here: auto-updating itself, code signing.

## Setup

From this folder:

```bash
npm.cmd install
```

This downloads Electron itself, which is a real application framework —
expect this to take a few minutes and download a few hundred MB. That's
normal for Electron, not a sign anything's wrong.

## Run it

```bash
npm.cmd start
```

A window opens, and a small icon should also appear in your system tray
(bottom-right, near the clock — it may be hidden under the little "^"
arrow that expands hidden tray icons).

## Testing it

You need a **Node-CLI** marketplace listing installed for real (this proof
only handles that runtime — sandboxed listings run in the browser, not
here). If you don't have one, submit and approve the Node template
(`agents/_template-node/`, zipped) first.

**To install one:** on the Marketplace, install that agent into a
campaign, then click **"Run with Scryboard Agent Runner"** on the screen
that follows. The runner window should pop up (or come to the front, if
already running) with the agent already showing in the list — nothing to
paste. If you'd rather test without a real install, the text box at the
bottom of the window still accepts a pasted link the same way.

You should see it appear in the list, showing "Running…" and then a
timestamp of when it last ran — and its widget should appear on your
Scryboard dashboard.

**Pause / Resume / Remove** are on each row. Pausing stops it from ticking
without forgetting it (resume picks up where it left off); Remove deletes
it and its files for good.

**To test backgrounding (the new part in this phase):**

1. With at least one agent installed and running, close the window using
   its **X button**, same as closing any normal window.
2. It should *not* quit — a system notification should appear explaining
   it's still running in the background, and the window disappears but the
   tray icon stays.
3. Wait for the agent's next scheduled tick (check the interval in its
   `scryboard.json`) and confirm its dashboard widget actually updates
   *while the window is closed* — that's the real proof this isn't just
   hiding, it's still doing work.
4. **Right-click the tray icon** — you should see Open, a "Start on login"
   checkbox, and Quit.
5. Click **Open** to bring the window back, or click the tray icon itself.
6. Click **Quit** — this time it should actually exit, and the tray icon
   should disappear.

**To test packages:** submit, approve, and install the "Package Test"
agent (source alongside this README's instructions, uses `date-fns`).
Should install and run with no error, and its widget should show a real
sentence — if the package failed to load, you'd see an error status
instead.

**To test secrets:** submit, approve, and install "Secrets Test." Clicking
Install (or "Run with Scryboard Agent Runner") should pop up a prompt
asking for `TEST_SECRET` *before* anything actually installs — type
literally anything, it's not a real credential. After confirming, it
should install and its widget should report the secret was present and
show its first few characters, proving it made it all the way from the
prompt into the running agent's code.

## Known limitations of this proof-of-concept build

- **Only a small, fixed list of packages** is supported —
  `@anthropic-ai/sdk`, `pdf-parse`, `jimp`, `zod`, `date-fns`. Anything
  else is refused at install time rather than half-working.
- **Unsigned.** Windows will likely warn about running software from an
  unknown publisher — expected until this is signed, which is deliberately
  a later step (see the code-signing discussion from earlier).
- **The tray icon is a plain generated square**, not a real logo — it
  proves the mechanism, not the final look.

## What happens when you install an agent

1. Calls `/api/agent/download` with your token — the server looks up which
   exact file your install is pinned to and hands it back.
2. Unpacks the `.zip`, reads `scryboard.json` to find the entry file and
   its poll schedule.
3. Writes every file to this app's own data folder and saves the install
   (token encrypted) so it survives a restart.
4. Starts ticking it on the schedule from its manifest — faster while a
   session is live, slower otherwise — for as long as the app is running,
   in the background or not.
