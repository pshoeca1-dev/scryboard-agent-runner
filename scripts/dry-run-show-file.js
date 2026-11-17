// Dry run for 0.2.20's showFile, no Electron needed:
//   node scripts/dry-run-show-file.js
// Checks that an app can only reveal an existing file inside its own
// output/ folder, at most once every 5 seconds, and never a folder, a
// full path, a ".." path or a link pointing outside.

const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const { createRevealer, REVEAL_GAP_MS } = require('../file-reveal')
const { createClient } = require('../scryboard-client')

async function main() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'reveal-'))
  const out = path.join(dir, 'output')
  await fs.mkdir(path.join(out, 'sub'), { recursive: true })
  await fs.writeFile(path.join(out, 'dagger.stl'), 'solid')
  await fs.writeFile(path.join(dir, 'secret.txt'), 'nope')

  const opened = []
  let clock = 1_000_000
  const reveal = createRevealer({ outputDir: out, opener: (p) => opened.push(p), now: () => clock })
  const client = createClient({ token: 't', baseUrl: 'http://127.0.0.1:1', showFile: reveal })

  const r = await client.showFile('dagger.stl')
  assert.deepEqual(r, { shown: true, file: 'dagger.stl' })
  assert.equal(opened[0], path.join(out, 'dagger.stl'))
  console.log('✓ shows a file in output/')

  assert.deepEqual(await client.showFile('dagger.stl'), { shown: false, reason: 'too_soon' })
  clock += REVEAL_GAP_MS
  assert.equal((await client.showFile('output/dagger.stl')).shown, true)
  console.log('✓ once every 5 seconds; "output/" prefix accepted')

  for (const bad of ['../secret.txt', path.join(dir, 'secret.txt'), 'C:\\Windows\\notepad.exe', 'sub', 'missing.stl', '', null]) {
    clock += REVEAL_GAP_MS
    await assert.rejects(client.showFile(bad), undefined, `should refuse ${bad}`)
  }
  console.log('✓ refuses .., full paths, folders, missing files, empty')

  try {
    await fs.symlink(path.join(dir, 'secret.txt'), path.join(out, 'link.txt'))
    clock += REVEAL_GAP_MS
    await assert.rejects(client.showFile('link.txt'))
    console.log('✓ refuses a link pointing outside output/')
  } catch (err) {
    if (err.code === 'EPERM') console.log('- link test skipped (Windows needs admin to make links)')
    else throw err
  }

  const noReveal = createClient({ token: 't', baseUrl: 'http://127.0.0.1:1' })
  await assert.rejects(noReveal.showFile('dagger.stl'), /not available/)
  console.log('✓ a client without a folder says showFile is not available')

  assert.equal(opened.length, 2)
  await fs.rm(dir, { recursive: true, force: true })
  console.log('\nSHOW FILE DRY RUN PASSED')
}

main().catch((err) => { console.error(err); process.exit(1) })
