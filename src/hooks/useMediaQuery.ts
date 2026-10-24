// Shared with Orrery: edit here in lm-chat, then run `npm run sync:shared` in Orrery.
import { useSyncExternalStore } from 'react'

/** Whether a CSS media query matches, kept current as the window changes. */
export default function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mql = window.matchMedia?.(query)
      if (!mql) return () => {}
      mql.addEventListener('change', onChange)
      return () => mql.removeEventListener('change', onChange)
    },
    () => window.matchMedia?.(query).matches ?? false,
    () => false,
  )
}

/** A window wide enough for the list (of chats, of castings) to sit in a sidebar beside the one open. */
export const WIDE = '(min-width: 900px)'
