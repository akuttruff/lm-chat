// A screen recording of a scenario, for the README: Chrome's screencast
// frames are kept while the steps run, resampled to a steady frame rate,
// and written as a GIF (gifski) and an MP4 (ffmpeg). Both encoders come
// from Homebrew: `brew install gifski ffmpeg`.
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
    frames.push({ t: p.metadata.timestamp, png: p.data })
    void send('Page.screencastFrameAck', { sessionId: p.sessionId })
  })
  const started = send('Page.startScreencast', { format: 'png', everyNthFrame: 1 })
  return {
    frames,
    async stop() {
      await started
      await sleep(300)
      await send('Page.stopScreencast')
      return frames
    },
  }
}

/** Scroll an element (or the window) to a position in small steps, so the recording shows the motion. */
export async function glide(evaluate, selector, to, ms = 900, steps = 18) {
  const from = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el && el.scrollHeight > el.clientHeight ? el.scrollTop : window.scrollY })()`)
  for (let i = 1; i <= steps; i++) {
    const eased = 0.5 - Math.cos((i / steps) * Math.PI) / 2
    const y = Math.round(from + (to - from) * eased)
    await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (el && el.scrollHeight > el.clientHeight) el.scrollTop = ${y}; else window.scrollTo(0, ${y}) })()`)
    await sleep(ms / steps)
  }
  return 'glided'
}

/**
 * The frames resampled to `fps` from the first to the last (each tick holds
 * the latest frame before it), then encoded. Returns the files written.
 */
export function encodeRecording(frames, { out, name, fps = 10, gifWidth = 480, mp4Width = 860, tail = 1.5 }) {
  if (frames.length < 2) throw new Error(`${name}: only ${frames.length} frame(s) were recorded`)
  const dir = mkdtempSync(join(tmpdir(), `${name}-frames-`))
  try {
    const t0 = frames[0].t
    const tEnd = frames[frames.length - 1].t + tail
    let i = 0
    let n = 0
    for (let t = t0; t <= tEnd; t += 1 / fps) {
      while (i + 1 < frames.length && frames[i + 1].t <= t) i++
      writeFileSync(join(dir, `${String(++n).padStart(4, '0')}.png`), Buffer.from(frames[i].png, 'base64'))
    }
    const gif = `${out}/${name}.gif`
    const mp4 = `${out}/${name}.mp4`
    execFileSync('gifski', ['--fps', String(fps), '--width', String(gifWidth), '--quality', '82', '-o', gif, ...Array.from({ length: n }, (_, k) => join(dir, `${String(k + 1).padStart(4, '0')}.png`))], { stdio: 'ignore' })
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(fps), '-i', join(dir, '%04d.png'), '-vf', `scale=${mp4Width}:-2`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '26', '-movflags', '+faststart', mp4], { stdio: 'ignore' })
    return { gif, mp4, frames: n, seconds: Math.round((n / fps) * 10) / 10 }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
