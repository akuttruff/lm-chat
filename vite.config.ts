import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import api from './server/api.ts'

// The browser no longer talks to LM Studio. The app server owns every turn,
// so there is no cross-origin request to proxy and no CORS surface at all --
// which also means the API token never leaves this machine.
export default defineConfig({
  // The api plugin answers everything under /api/, including
  // /api/model-config (the manifest, then LM Studio's own capability list).
  plugins: [react(), api()],
  server: {
    // Bind to all interfaces so a phone can reach the dev server over Wi-Fi.
    host: true,
    port: 8000,
    strictPort: true,
    // The coverage report and data dir live in the project; watching them
    // would reload the app on every test run.
    watch: { ignored: ['**/coverage/**', '**/.data/**'] },
  },
  preview: { host: true, port: 8000, strictPort: true },
})
