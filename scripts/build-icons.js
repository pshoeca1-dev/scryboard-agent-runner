// Rasterizes assets/icon.svg into the PNG sizes the app and the installer
// need, plus a Windows .ico. Run it with `npm run build:icons` after
// changing the SVG -- the SVG is the source of truth, everything else in
// assets/ is generated from it and can be deleted and rebuilt at will.
//
// This runs under Electron rather than plain Node on purpose: Chromium is
// already a dependency here and it renders SVG properly (antialiasing,
// rounded corners, the lot). The alternative was adding a native image
// library just to draw six shapes.

const { app, BrowserWindow } = require('electron')
const fs = require('node:fs/promises')
const path = require('node:path')

const ASSETS = path.join(__dirname, '..', 'assets')
const SOURCE = path.join(ASSETS, 'icon.svg')

// 16 and 32 are the tray, at 100% and 200% display scaling. 256 is the
// window/taskbar icon. The rest exist so the .ico has a crisp entry at
// whatever size Windows decides to pull from it (Explorer, alt-tab, the
// installer, the Start menu -- they all pick different ones).
const SIZES = [16, 32, 48, 64, 128, 256]

// Kept on disk because main.js loads them at runtime; the others are only
// ever embedded in the .ico, so they don't need to ship as loose files.
const KEEP_AS_PNG = new Set([16, 32, 256])

async function renderSizes(svgText) {
  const win = new BrowserWindow({ show: false, width: 600, height: 600 })
  await win.loadURL('data:text/html,<body>')

  // The source SVG declares only a viewBox, so give the <img> an explicit
  // size to scale to rather than relying on Chromium's default for
  // intrinsically-sizeless SVGs.
  const dataUrl = 'data:image/svg+xml;base64,' + Buffer.from(svgText, 'utf8').toString('base64')

  const rendered = new Map()
  for (const size of SIZES) {
    const pngDataUrl = await win.webContents.executeJavaScript(`
      (async () => {
        const img = new Image(${size}, ${size})
        img.src = ${JSON.stringify(dataUrl)}
        await img.decode()
        const canvas = document.createElement('canvas')
        canvas.width = ${size}
        canvas.height = ${size}
        const ctx = canvas.getContext('2d')
        ctx.drawImage(img, 0, 0, ${size}, ${size})
        return canvas.toDataURL('image/png')
      })()
    `)
    rendered.set(size, Buffer.from(pngDataUrl.split(',')[1], 'base64'))
  }

  win.destroy()
  return rendered
}

// An .ico is a tiny directory header followed by the image payloads. Since
// Vista those payloads are allowed to be PNGs as-is, which means this is
// just repackaging the buffers we already have -- no bitmap encoding.
function buildIco(rendered) {
  const entries = [...rendered.entries()].sort((a, b) => a[0] - b[0])
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // 1 = icon
  header.writeUInt16LE(entries.length, 4)

  const directory = Buffer.alloc(16 * entries.length)
  let offset = header.length + directory.length

  entries.forEach(([size, png], i) => {
    const at = i * 16
    // 0 means 256 in this field -- it's a single byte, so 256 doesn't fit.
    directory.writeUInt8(size >= 256 ? 0 : size, at + 0)
    directory.writeUInt8(size >= 256 ? 0 : size, at + 1)
    directory.writeUInt8(0, at + 2) // palette size, 0 for truecolor
    directory.writeUInt8(0, at + 3) // reserved
    directory.writeUInt16LE(1, at + 4) // color planes
    directory.writeUInt16LE(32, at + 6) // bits per pixel
    directory.writeUInt32LE(png.length, at + 8)
    directory.writeUInt32LE(offset, at + 12)
    offset += png.length
  })

  return Buffer.concat([header, directory, ...entries.map(([, png]) => png)])
}

// Destroying the offscreen window leaves zero windows open, and Electron's
// default response to that is to quit -- which would race the writes below
// and leave half-written files behind. This script decides when it's done.
app.on('window-all-closed', () => {})

app.whenReady().then(async () => {
  const svgText = await fs.readFile(SOURCE, 'utf8')
  const rendered = await renderSizes(svgText)

  for (const [size, png] of rendered) {
    if (!KEEP_AS_PNG.has(size)) continue
    const file = path.join(ASSETS, `icon-${size}.png`)
    await fs.writeFile(file, png)
    console.log(`wrote ${path.relative(process.cwd(), file)} (${png.length} bytes)`)
  }

  const ico = path.join(ASSETS, 'icon.ico')
  await fs.writeFile(ico, buildIco(rendered))
  console.log(`wrote ${path.relative(process.cwd(), ico)} (${SIZES.length} sizes)`)

  app.exit(0)
}).catch((err) => {
  // Without this a failure mid-render exits 0 with a half-written assets/
  // folder, which then ships as a broken icon.
  console.error(err)
  app.exit(1)
})
