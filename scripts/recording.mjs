// A screen recording of a scenario, for the README: Chrome's screencast
// frames are kept while the steps run, resampled to a steady frame rate,
// and written as an MP4 and, from it, a GIF, both with ffmpeg (`brew install ffmpeg`).
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Start keeping frames. `on` subscribes to a DevTools event; `send` sends a
 * command. Chrome sends a frame whenever the page paints, so a pause gives
 * none and a scroll gives many: the timestamps say when each was true.
 */
export function startRecording({ send, on }) {
  const frames = []
  on('Page.screencastFrame', (p) => {
    frames.push({ t: p.metadata.timestamp, jpeg: p.data })
    void send('Page.screencastFrameAck', { sessionId: p.sessionId })
  })
  const started = send('Page.startScreencast', { format: 'jpeg', quality: 92, everyNthFrame: 1 })
  return {
    frames,
    async stop() {
      await started
      await sleep(400)
      await send('Page.stopScreencast')
      return frames
    },
  }
}

/**
 * Scroll an element (or the window) to a position over `ms`, eased, driven
 * by the page's own animation frames, so the recording shows the motion the
 * way a finger would make it. A position past the end scrolls to the end.
 */
export async function glide(evaluate, selector, to, ms = 1400) {
  return evaluate(`new Promise((resolve) => {
    const el = document.querySelector(${JSON.stringify(selector)})
    const box = el && el.scrollHeight > el.clientHeight ? el : null
    const from = box ? box.scrollTop : window.scrollY
    const max = box ? box.scrollHeight - box.clientHeight : document.documentElement.scrollHeight - window.innerHeight
    const to = Math.min(${to}, max)
    const t0 = performance.now()
    const step = (now) => {
      const p = Math.min(1, (now - t0) / ${ms})
      const eased = 0.5 - Math.cos(p * Math.PI) / 2
      const y = from + (to - from) * eased
      if (box) box.scrollTop = y; else window.scrollTo(0, y)
      if (p < 1) requestAnimationFrame(step); else resolve('glided')
    }
    requestAnimationFrame(step)
  })`)
}

/** Type into a field the way a person would: focused, then a few characters at a time. */
export async function typeInto(send, evaluate, selector, text, perCharMs = 26) {
  const focused = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return 'missing ' + ${JSON.stringify(selector)}; el.focus(); return 'focused' })()`)
  if (String(focused).startsWith('missing')) return focused
  for (const ch of text) {
    await send('Input.insertText', { text: ch })
    await sleep(perCharMs + (ch === ' ' ? 40 : 0))
  }
  return 'typed'
}

/** Wait until an expression in the page is true, looking every `pollMs`; 'timeout' if it never is. */
export async function waitUntil(evaluate, expression, timeoutMs = 120_000, pollMs = 250) {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (await evaluate(expression)) return 'ready'
    await sleep(pollMs)
  }
  return 'timeout'
}

/**
 * The frames resampled to `fps` from the first to the last, then encoded.
 * A stretch where nothing changed for longer than `maxGap` seconds is
 * shortened to it (a model's pause before its first word, a page settling),
 * so the recording keeps its motion but not its waiting; `fast` names a
 * window, or a list of them (in the frames' own timestamps, `{ from, to,
 * factor }`), to run `factor` times faster, for a wait that repaints a
 * counter or a long answer streaming in; `speed` then plays the whole
 * thing that much faster.
 */
export function encodeRecording(frames, { out, name, wide = false, fps = 24, gifFps = 20, tail = 1.2, maxGap = 0.9, speed = 1, fast = null }) {
  if (frames.length < 2) throw new Error(`${name}: only ${frames.length} frame(s) were recorded`)
  const dir = mkdtempSync(join(tmpdir(), `${name}-frames-`))
  try {
    // A timeline with the long gaps closed up, and the windows (a wait for the model) run that much faster.
    const windows = fast ? [fast].flat() : []
    const timed = []
    let t = 0
    for (let i = 0; i < frames.length; i++) {
      if (i > 0) {
        let dt = Math.min(frames[i].t - frames[i - 1].t, maxGap)
        const w = windows.find((x) => frames[i].t >= x.from && frames[i].t <= x.to)
        if (w) dt /= w.factor
        t += dt
      }
      timed.push({ t: t / speed, jpeg: frames[i].jpeg })
    }
    const tEnd = timed[timed.length - 1].t + tail
    const files = []
    let i = 0
    for (let tick = 0; tick <= tEnd; tick += 1 / fps) {
      while (i + 1 < timed.length && timed[i + 1].t <= tick) i++
      const file = join(dir, `${String(files.length + 1).padStart(4, '0')}.jpg`)
      writeFileSync(file, Buffer.from(timed[i].jpeg, 'base64'))
      files.push(file)
    }
    const gif = `${out}/${name}.gif`
    const mp4 = `${out}/${name}.mp4`
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(fps), '-i', join(dir, '%04d.jpg'), '-vf', `scale=${wide ? 1600 : 860}:-2`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '24', '-movflags', '+faststart', mp4], { stdio: 'ignore' })
    // The GIF from the MP4, with a palette made for it.
    const width = wide ? 960 : 430
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', mp4, '-vf', `fps=${gifFps},scale=${width}:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`, '-loop', '0', gif], { stdio: 'ignore' })
    return { gif, mp4, frames: files.length, seconds: Math.round((files.length / fps) * 10) / 10 }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
