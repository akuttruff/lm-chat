import path from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import api from './server/api.ts'

// The browser no longer talks to LM Studio. The app server owns every turn,
// so there is no cross-origin request to proxy and no CORS surface at all --
// which also means the API token never leaves this machine.
export default defineConfig(({ command, isPreview }) => {
  // `vite preview` (isPreview) is the one persistent, real-data instance --
  // reachable locally and, via `tailscale serve`, remotely. `vite dev` is a
  // separate, throwaway copy for testing code changes: it must never touch
  // the real conversations, since its own in-memory store would only ever
  // see its own writes, not the preview instance's -- two processes quietly
  // diverging on what "the current chats" are.
  const usingRealData = command === 'build' || isPreview
  const dir = usingRealData ? undefined : path.resolve(process.cwd(), '.data-dev')

  return {
    // The api plugin answers everything under /api/, including
    // /api/model-config (the manifest, then LM Studio's own capability list).
    plugins: [react(), api({ dir })],
    server: {
      // Bind to all interfaces so a phone can reach the dev server over Wi-Fi.
      host: true,
      port: 8000,
      strictPort: true,
      // Also reachable over Tailscale, via `tailscale serve`.
      allowedHosts: ['amies-mac-studio.tail1585ef.ts.net'],
      // The coverage report and data dirs live in the project; watching them
      // would reload the app on every test run.
      watch: { ignored: ['**/coverage/**', '**/.data/**', '**/.data-dev/**'] },
    },
    // A separate port from `server` above: this is the persistent, built
    // instance Tailscale points at, so it can run alongside `npm run dev`
    // (unbundled, for local iteration) without a port clash.
    preview: { host: true, port: 8010, strictPort: true, allowedHosts: ['amies-mac-studio.tail1585ef.ts.net'] },
  }
})
