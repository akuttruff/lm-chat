import type { Message } from '../types.ts'

/**
 * Where you'd scrolled to in a conversation: which message was at the top of
 * the view, and how far into it -- so switching chats or closing the app and
 * coming back can put you exactly where you left off, rather than always
 * jumping to the latest message.
 */
export interface ScrollAnchor {
  anchorId: Message['id']
  /** Pixels the view had scrolled past the anchor's own top edge. */
  offset: number
}

const KEY_PREFIX = 'lm-chat.scroll.'

/** Wrapped in try/catch throughout: private browsing, quota, disabled storage. */
export function loadScrollAnchor(conversationId: string): ScrollAnchor | null {
  try {
    const raw = localStorage.getItem(KEY_PREFIX + conversationId)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<ScrollAnchor>
    if (typeof parsed.offset !== 'number' || (typeof parsed.anchorId !== 'string' && typeof parsed.anchorId !== 'number')) {
      return null
    }
    return { anchorId: parsed.anchorId, offset: parsed.offset }
  } catch {
    return null
  }
}

/** `null` clears it -- used once you've scrolled back down to "caught up". */
export function saveScrollAnchor(conversationId: string, anchor: ScrollAnchor | null): void {
  try {
    const key = KEY_PREFIX + conversationId
    if (!anchor) localStorage.removeItem(key)
    else localStorage.setItem(key, JSON.stringify(anchor))
  } catch { /* not persisted this time; still works for the session */ }
}

/**
 * The message currently at the top of the visible area: the last one whose
 * own top has already scrolled past the container's top edge. Rows must
 * carry `data-msg-id`, in document order.
 */
export function findAnchor(container: HTMLElement): ScrollAnchor | null {
  let found: HTMLElement | null = null
  for (const row of container.querySelectorAll<HTMLElement>('[data-msg-id]')) {
    if (row.offsetTop > container.scrollTop) break
    found = row
  }
  const anchorId = found?.dataset.msgId
  return anchorId == null ? null : { anchorId, offset: container.scrollTop - found!.offsetTop }
}

export interface InitialScrollState {
  shown: number
  following: boolean
  /** Consumed once, by the effect that actually scrolls to it. */
  restore: ScrollAnchor | null
}

/**
 * What to render with, and where to end up, the first time a thread mounts.
 * A pure function so the mount-time decision -- read once, via lazy
 * `useState` initializers -- is unit-testable without a DOM.
 */
export function computeInitialScrollState(
  conversationId: string,
  messages: Message[],
  initialWindow: number,
): InitialScrollState {
  const fallback: InitialScrollState = { shown: initialWindow, following: true, restore: null }
  const saved = loadScrollAnchor(conversationId)
  if (!saved) return fallback
  // Stringified: an id can be a number (e.g. a pre-migration React key) but
  // dataset attributes -- and so a saved anchorId round-tripped through
  // JSON -- are always strings.
  const index = messages.findIndex((m) => String(m.id) === String(saved.anchorId))
  if (index === -1) return fallback // that message is gone; nothing to restore to
  const messagesFromEnd = messages.length - index
  return { shown: Math.max(initialWindow, messagesFromEnd), following: false, restore: saved }
}
