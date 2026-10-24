// Screenshots of the app for the README, taken with headless Chrome over its
// DevTools protocol (a raw WebSocket; no npm dependency). Run the dev server
// on the demo database first:
//
//   npm run seed:demo && npm run dev        (in one terminal)
//   npm run screenshots [scenario]          (in another; writes docs/screenshots/*.png)
//
// Needs Google Chrome at the usual macOS path, or CHROME=/path/to/chrome.
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeRecording, glide, startRecording, typeInto, waitUntil } from './recording.mjs'

const URL = process.env.LM_CHAT_URL ?? 'http://127.0.0.1:8000'
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const OUT = 'docs/screenshots'
const PORT = Number(process.env.CHROME_PORT ?? 9336)

const PHONE = { width: 430, height: 932, scale: 2, mobile: true }
const DESKTOP = { width: 1280, height: 840, scale: 2, mobile: false }

/**
 * Each scenario is a list of steps against a fresh browser profile:
 *  click <text>          the innermost element whose text contains it, or its enclosing button
 *  sel <css>             click the first element matching the selector
 *  aria <label>          click the element with that aria-label
 *  row <text>            click the chat whose name in the list contains it
 *  every <css>           click every element matching the selector
 *  wait <ms>             pause (animations, lazy chunks)
 *  scroll <css> <px>     scroll an element, or the window when the selector matches nothing
 */
// The active chat is kept on the server, so every scenario opens the chat it wants first.
const lisbon = [['wait', 1500], ['aria', 'Chats'], ['wait', 800], ['row', 'Lisbon in November'], ['wait', 1500]]
/** What the recordings ask, and how they know the reply is in: the header says "connected" again and nothing is streaming. */
const QUESTION = "In three sentences: the one thing I shouldn't miss, and what to wear for it?"
const REPLIED = `(() => { const s = document.querySelector('.status')?.textContent || ''; return /connected/.test(s) && !document.querySelector('.streaming, .pending') })()`
/** The model's first word is on screen: the header says it is writing. */
const WRITING = `/writing/i.test(document.querySelector('.status')?.textContent || '')`

const scenarios = [
  { name: 'thread-phone', view: PHONE, steps: [...lisbon, ['scroll', '.thread', 0]] },
  { name: 'reasoning-phone', view: PHONE, steps: [...lisbon, ['click', 'Thought for'], ['wait', 500], ['scroll', '.thread', 0]] },
  { name: 'tools-phone', view: PHONE, steps: [...lisbon, ['scroll', '.thread', 330]] },
  { name: 'table-phone', view: PHONE, steps: [['wait', 1500], ['aria', 'Chats'], ['wait', 800], ['row', 'Weekly meal plan'], ['wait', 1500], ['scroll', '.thread', 0]] },
  { name: 'code-phone', view: PHONE, steps: [['wait', 1500], ['aria', 'Chats'], ['wait', 800], ['row', 'Debounce in TypeScript'], ['wait', 1500], ['scroll', '.thread', 0]] },
  { name: 'chats-phone', view: PHONE, steps: [...lisbon, ['aria', 'Chats'], ['wait', 900]] },
  { name: 'settings-phone', view: PHONE, steps: [...lisbon, ['aria', 'Chats'], ['wait', 800], ['click', 'Settings'], ['wait', 1200]] },
  { name: 'memories-phone', view: PHONE, steps: [...lisbon, ['aria', 'Chats'], ['wait', 800], ['click', 'Settings'], ['wait', 1000], ['click', 'Memories'], ['wait', 1000]] },
  // The memory tools at work (for lm-memory-mcp's README), each card opened to show what was sent and what came back.
  { name: 'memory-phone', view: PHONE, steps: [['wait', 1500], ['aria', 'Chats'], ['wait', 800], ['row', 'Dinner party for six'], ['wait', 1500], ['every', '.tool-head'], ['wait', 600], ['scroll', '.thread', 0]] },
  { name: 'memory-desktop', view: DESKTOP, steps: [['wait', 1500], ['row', 'Dinner party for six'], ['wait', 1500], ['every', '.tool-head'], ['wait', 600], ['scroll', '.thread', 0]] },
  // A draw_cards result laid out as its spread (for tarot-mcp's README).
  { name: 'tarot-phone', view: PHONE, steps: [['wait', 1500], ['aria', 'Chats'], ['wait', 800], ['row', 'A new job'], ['wait', 2000], ['scroll', '.thread', 0]] },
  { name: 'tarot-desktop', view: DESKTOP, steps: [['wait', 1500], ['row', 'A new job'], ['wait', 2000], ['scroll', '.thread', 0]] },
  { name: 'desktop', view: DESKTOP, steps: [['wait', 1500], ['row', 'Lisbon in November'], ['wait', 1500], ['scroll', '.thread', 0]] },
  // Walkthroughs, recorded (see recording.mjs): the phone's and the desktop's.
  // A question typed into the Lisbon chat and answered by the model, for real: the recording waits for the reply, and the encoder closes up the pauses.
  { name: 'demo-phone', view: PHONE, record: true, steps: [...lisbon, ['wait', 500], ['glide', '.thread', 99999, 1300], ['wait', 500], ['type', '.composer-input', QUESTION], ['wait', 400], ['send'], ['wait', 300], ['until', WRITING, 120000], ['until', REPLIED, 150000], ['wait', 700], ['glide', '.thread', 99999, 900], ['wait', 1600]] },
  { name: 'demo-desktop', view: DESKTOP, record: true, steps: [['wait', 1200], ['row', 'Lisbon in November'], ['wait', 1300], ['glide', '.thread', 99999, 1300], ['wait', 500], ['type', '.composer-input', QUESTION], ['wait', 400], ['send'], ['wait', 300], ['until', WRITING, 120000], ['until', REPLIED, 150000], ['wait', 700], ['glide', '.thread', 99999, 900], ['wait', 1600]] },
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function withChrome(view, fn) {
  // A fresh profile per scenario, so nothing carries over.
  const profile = mkdtempSync(join(tmpdir(), 'lm-chat-shots-'))
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, '--no-first-run', '--no-default-browser-check', `--window-size=${view.width},${view.height}`, '--hide-scrollbars', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' })
  const exited = new Promise((r) => chrome.on('exit', r))
  try {
    let targets = []
    for (let i = 0; i < 40 && targets.length === 0; i++) {
      await sleep(250)
      try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json() } catch { /* not up yet */ }
    }
    const page = targets.find((t) => t.type === 'page')
    if (!page) throw new Error('Chrome did not expose a page target')
    const ws = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((r) => (ws.onopen = r))
    let id = 0
    const pending = new Map()
    const listeners = new Map()
    const on = (method, fn) => listeners.set(method, fn)
    ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } else if (m.method && listeners.has(m.method)) listeners.get(m.method)(m.params) }
    const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })
    const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.result?.value
    await send('Page.enable')
    await send('Emulation.setDeviceMetricsOverride', { width: view.width, height: view.height, deviceScaleFactor: view.scale, mobile: view.mobile })
    await fn({ send, evaluate, on })
    ws.close()
  } finally {
    chrome.kill()
    await exited
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}

const clickText = (text, sel = 'button, div, span, h2, h3, h4, b, strong, em, p, li, a, summary') =>
  `(() => { const t = ${JSON.stringify(text)}; const all = [...document.querySelectorAll(${JSON.stringify(sel)})].filter((e) => e.textContent.includes(t)); const el = all.find((e) => !all.some((o) => o !== e && e.contains(o))); if (!el) return 'missing ' + t; (el.closest('button, a, summary, li') ?? el).click(); return 'clicked' })()`

async function run(scenario) {
  await withChrome(scenario.view, async ({ send, evaluate, on }) => {
    await send('Page.navigate', { url: URL + (scenario.path ?? '') })
    await sleep(2500)
    const recording = scenario.record ? startRecording({ send, on }) : null
    // The wait between sending a question and the model's first word is run fast in the recording.
    const fast = { from: 0, to: 0, factor: 5 }
    for (const [op, a, b, c] of scenario.steps) {
      let result = ''
      if (op === 'click') result = await evaluate(clickText(a))
      else if (op === 'glide') result = await glide(evaluate, a, b, c)
      else if (op === 'type') result = await typeInto(send, evaluate, a, b)
      else if (op === 'send') { result = await evaluate(`(() => { const el = document.querySelector('[aria-label="Send"]'); if (!el) return 'missing Send'; el.click(); return 'sent' })()`); fast.from = Date.now() / 1000 }
      else if (op === 'until') { result = await waitUntil(evaluate, a, b); if (result === 'timeout') throw new Error(`${scenario.name}: gave up waiting for ${a}`); if (fast.from && !fast.to) fast.to = Date.now() / 1000 }
      else if (op === 'sel') result = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(a)}); if (!el) return 'missing ' + ${JSON.stringify(a)}; el.click(); return 'clicked' })()`)
      else if (op === 'every') result = await evaluate(`(() => { const els = [...document.querySelectorAll(${JSON.stringify(a)})]; if (!els.length) return 'missing ' + ${JSON.stringify(a)}; els.forEach((el) => el.click()); return 'clicked ' + els.length })()`)
      else if (op === 'row') result = await evaluate(clickText(a, '.conv-name'))
      else if (op === 'aria') result = await evaluate(`(() => { const el = document.querySelector('[aria-label=' + ${JSON.stringify(JSON.stringify(a))} + ']'); if (!el) return 'missing ' + ${JSON.stringify(a)}; el.click(); return 'clicked' })()`)
      else if (op === 'wait') { await sleep(a); continue }
      else if (op === 'scroll') result = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(a)}); if (el && el.scrollHeight > el.clientHeight) { el.scrollTop = ${b}; return 'scrolled' } window.scrollTo(0, ${b}); return 'scrolled window' })()`)
      if (String(result).startsWith('missing')) throw new Error(`${scenario.name}: ${result}`)
      await sleep(700)
    }
    if (recording) {
      const frames = await recording.stop()
      const made = encodeRecording(frames, { out: OUT, name: scenario.name, wide: !scenario.view.mobile, speed: scenario.speed ?? 1, fast: fast.to ? fast : null })
      console.log(`wrote ${made.gif} and ${made.mp4} (${made.seconds} s, ${made.frames} frames)`)
      return
    }
    const shot = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(`${OUT}/${scenario.name}.png`, Buffer.from(shot.result.data, 'base64'))
    console.log(`wrote ${OUT}/${scenario.name}.png`)
  })
}

mkdirSync(OUT, { recursive: true })
const only = process.argv[2]
for (const s of scenarios) {
  if (only && s.name !== only) continue
  await run(s)
}
