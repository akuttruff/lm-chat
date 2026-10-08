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

/** A window wide enough for the chat list to sit beside the thread. */
export const WIDE = '(min-width: 900px)'
