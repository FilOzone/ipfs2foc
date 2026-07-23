/**
 * Launch invariants over the production build: renders app/dist in headless
 * Chrome and asserts the landing promises that must never silently regress.
 * Runs in the Pages deploy before the artifact upload, so a violation fails
 * the deploy loudly instead of shipping.
 *
 * Invariants:
 *   1. The fit statement renders with the cap constants from run-limits.ts
 *      (parsed from source here, so the assertion cannot drift from the code).
 *   2. The trust line renders: preparation is free, cost before connecting.
 *   3. The default network matches EXPECTED_DEFAULT_NETWORK (env; defaults to
 *      the current source value so the same probe passes after the mainnet
 *      flip by flipping the variable, not this file).
 *   4. The landing shows no wallet UI.
 *   5. The page loads with zero page errors.
 *
 * Chrome comes from the host: puppeteer-core channel 'chrome' (the Pages
 * runner ships Google Chrome; verified: actions/runner-images
 * Ubuntu2404-Readme.md lists it). Override with PUPPETEER_EXECUTABLE_PATH.
 */

import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(appDir, 'dist')

function die(msg) {
  console.error(`launch-invariants: ${msg}`)
  process.exit(1)
}

/** The cap constants, parsed from the source of truth. */
function readLimits() {
  const src = readFileSync(join(appDir, 'src/run-limits.ts'), 'utf8')
  const cids = src.match(/HOSTED_MAX_CIDS = (\d+)/)?.[1]
  const bytesExpr = src.match(/HOSTED_MAX_RUN_BYTES = ([\d* ]+)/)?.[1]
  if (cids == null || bytesExpr == null) die('could not parse cap constants from run-limits.ts')
  // The regex admits digits, spaces, and '*' only; factors are multiplied
  // numerically, never evaluated as code.
  const bytes = bytesExpr.split('*').reduce((a, b) => a * Number(b.trim()), 1)
  return { maxCids: Number(cids), maxBytes: bytes }
}

/** Mirrors fmtLimitBytes in components/format.ts (a ceiling reads round). */
function fmtLimitBytes(n) {
  const gib = 1024 * 1024 * 1024
  if (n % gib === 0) return `${n / gib} GiB`
  return `${Math.round(n / (1024 * 1024))} MiB`
}

function readDefaultNetwork() {
  const src = readFileSync(join(appDir, 'src/capabilities.ts'), 'utf8')
  const net = src.match(/DEFAULT_NETWORK = '(\w+)'/)?.[1]
  if (net == null) die('could not parse DEFAULT_NETWORK from capabilities.ts')
  return net
}

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
}

/** Serves dist under whatever base the build was made with. */
function serve() {
  return createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname
    for (const candidate of [path, path.replace(/^\/[^/]+/, ''), '/index.html']) {
      const resolved = candidate === '' || candidate === '/' ? '/index.html' : candidate
      try {
        const file = readFileSync(join(dist, resolved))
        // The type must come from the resolved file: serving the document as
        // octet-stream makes Chrome treat it as a download and abort.
        res.writeHead(200, { 'content-type': MIME[extname(resolved)] ?? 'application/octet-stream' })
        res.end(file)
        return
      } catch {}
    }
    res.writeHead(404)
    res.end()
  })
}

const step = (m) => process.env.DEBUG_STEPS && console.error(`step: ${m}`)
step('start')
const limits = readLimits()
const sourceNetwork = readDefaultNetwork()
const expectedNetwork = process.env.EXPECTED_DEFAULT_NETWORK ?? sourceNetwork
if (sourceNetwork !== expectedNetwork) {
  die(`DEFAULT_NETWORK is '${sourceNetwork}' but EXPECTED_DEFAULT_NETWORK is '${expectedNetwork}'`)
}

const index = readFileSync(join(dist, 'index.html'), 'utf8')
const base = index.match(/(?:src|href)="([^"]*)\/assets\//)?.[1] ?? ''

step('parsed')
const server = serve()
await new Promise((resolve) => server.listen(0, resolve))
const url = `http://127.0.0.1:${server.address().port}${base}/`

// An explicit binary path: puppeteer-core's channel resolution can stall.
// PUPPETEER_EXECUTABLE_PATH overrides; otherwise the platform's stable
// Chrome install (the Pages runner ships one at /opt/google/chrome/chrome).
function chromePath() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH != null) return process.env.PUPPETEER_EXECUTABLE_PATH
  const candidates =
    process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
      : ['/opt/google/chrome/chrome', '/usr/bin/google-chrome']
  for (const p of candidates) {
    try {
      readFileSync(p, { length: 0 })
      return p
    } catch {}
  }
  die(`no Chrome binary found; set PUPPETEER_EXECUTABLE_PATH (tried: ${candidates.join(', ')})`)
}

step('listening ' + url)
const browser = await puppeteer.launch({
  executablePath: chromePath(),
  headless: true,
  args: ['--no-sandbox'],
})
try {
  step('launched')
  const page = await browser.newPage()
  const pageErrors = []
  page.on('pageerror', (err) => pageErrors.push(String(err)))
  // domcontentloaded, not networkidle: the app's p2p transport holds
  // connections open, so idle never arrives. The selector is the ready gate.
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await page.waitForSelector('.cid-input', { timeout: 15_000 })

  step('rendered')
  const text = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '))

  const fit = `A run here handles up to ${limits.maxCids.toLocaleString('en-US')} items, ${fmtLimitBytes(limits.maxBytes)} total.`
  if (!text.includes(fit)) die(`fit statement missing or drifted; expected: "${fit}"`)

  const trust = 'Preparation is free. You see the cost before connecting anything.'
  if (!text.includes(trust)) die(`trust line missing: "${trust}"`)

  const netValue = await page.$eval('#network', (el) => el.value)
  if (netValue !== expectedNetwork) die(`landing network is '${netValue}', expected '${expectedNetwork}'`)

  if (text.includes('Connect wallet')) die('landing shows wallet UI')
  const walletRow = await page.$('.wallet-row')
  if (walletRow != null) die('landing renders .wallet-row')

  if (pageErrors.length > 0) die(`page errors on landing: ${pageErrors.join(' | ')}`)

  console.log(`launch-invariants: ok (caps ${limits.maxCids}/${fmtLimitBytes(limits.maxBytes)}, network ${expectedNetwork})`)
} finally {
  await browser.close()
  server.close()
}
