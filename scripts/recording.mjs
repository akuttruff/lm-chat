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
 * way a finger would make it.
 */
export async function glide(evaluate, selector, to, ms = 1800) {
  return evaluate(`new Promise((resolve) => {
    const el = document.querySelector(${JSON.stringify(selector)})
    const box = el && el.scrollHeight > el.clientHeight ? el : null
    const from = box ? box.scrollTop : window.scrollY
    const to = ${to}
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

/**
 * The frames resampled to `fps` from the first to the last (each tick holds
 * the latest frame before it), then encoded. Returns the files written.
 */
export function encodeRecording(frames, { out, name, wide = false, fps = 24, gifFps = 15, tail = 1.2 }) {
  if (frames.length < 2) throw new Error(`${name}: only ${frames.length} frame(s) were recorded`)
  const dir = mkdtempSync(join(tmpdir(), `${name}-frames-`))
  try {
    const t0 = frames[0].t
    const tEnd = frames[frames.length - 1].t + tail
    const files = []
    let i = 0
    for (let t = t0; t <= tEnd; t += 1 / fps) {
      while (i + 1 < frames.length && frames[i + 1].t <= t) i++
      const file = join(dir, `${String(files.length + 1).padStart(4, '0')}.jpg`)
      writeFileSync(file, Buffer.from(frames[i].jpeg, 'base64'))
      files.push(file)
    }
    const gif = `${out}/${name}.gif`
    const mp4 = `${out}/${name}.mp4`
    // The MP4 at full rate and size; the GIF slower and smaller, since a GIF's bytes grow with both.
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(fps), '-i', join(dir, '%04d.jpg'), '-vf', `scale=${wide ? 1600 : 860}:-2`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '24', '-movflags', '+faststart', mp4], { stdio: 'ignore' })
    // The GIF from the MP4, with a palette made for it: gifski wants PNG frames, and these are JPEG.
    const width = wide ? 960 : 430
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', mp4, '-vf', `fps=${gifFps},scale=${width}:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`, '-loop', '0', gif], { stdio: 'ignore' })
    return { gif, mp4, frames: files.length, seconds: Math.round((files.length / fps) * 10) / 10 }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
