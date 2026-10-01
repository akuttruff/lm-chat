/**
 * How the model's replies are typeset -- a preference of the device, not
 * the server: a phone and a laptop want different sizes, and it changes no
 * one else's screen. Thinking blocks and tool cards keep their own fonts;
 * only the reply bubble follows this.
 */
export const REPLY_FONTS = [
  { value: 'system', label: 'System (SF Pro)' },
  { value: 'serif', label: 'Serif (New York)' },
  { value: 'rounded', label: 'Rounded (SF Pro Rounded)' },
  { value: 'mono', label: 'Mono (SF Mono)' },
] as const
export type ReplyFont = (typeof REPLY_FONTS)[number]['value']

export const REPLY_SIZES = [
  { value: 'small', label: 'Small' },
  { value: 'medium', label: 'Medium' },
  { value: 'large', label: 'Large' },
] as const
export type ReplySize = (typeof REPLY_SIZES)[number]['value']

export interface ReplyStyle {
  font: ReplyFont
  size: ReplySize
}

export const DEFAULT_REPLY_STYLE: ReplyStyle = { font: 'system', size: 'medium' }

const KEY = 'lm-chat.replyStyle'

const isFont = (v: unknown): v is ReplyFont => REPLY_FONTS.some((f) => f.value === v)
const isSize = (v: unknown): v is ReplySize => REPLY_SIZES.some((s) => s.value === v)

/** The saved style, or the default; a missing or garbled value never throws. */
export function loadReplyStyle(): ReplyStyle {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return DEFAULT_REPLY_STYLE
    const parsed = JSON.parse(raw) as Partial<ReplyStyle>
    return {
      font: isFont(parsed.font) ? parsed.font : DEFAULT_REPLY_STYLE.font,
      size: isSize(parsed.size) ? parsed.size : DEFAULT_REPLY_STYLE.size,
    }
  } catch {
    return DEFAULT_REPLY_STYLE
  }
}

export function saveReplyStyle(style: ReplyStyle): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(style))
  } catch { /* private mode or full: the choice just doesn't survive a reload */ }
}

/** Put the style on the document, where App.css picks it up (see [data-reply-font]). */
export function applyReplyStyle(style: ReplyStyle): void {
  const root = document.documentElement
  root.dataset.replyFont = style.font
  root.dataset.replySize = style.size
}
