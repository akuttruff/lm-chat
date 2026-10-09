import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import App from './App.jsx'

// The app shell from cache on later launches: see public/sw.js. Only on a
// built app over a secure origin (the tailnet's HTTPS, or localhost).
if ('serviceWorker' in navigator && window.isSecureContext && import.meta.env.PROD) {
  void navigator.serviceWorker.register('/sw.js')
}

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('#root is missing from index.html')

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
