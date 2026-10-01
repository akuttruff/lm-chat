import { useCallback, useEffect, useState } from 'react'
import { applyReplyStyle, loadReplyStyle, saveReplyStyle } from '../lib/replyStyle'
import type { ReplyStyle } from '../lib/replyStyle'

/** This device's reply typography: read once, applied to the page, saved on change. */
export default function useReplyStyle(): [ReplyStyle, (next: ReplyStyle) => void] {
  const [style, setStyle] = useState<ReplyStyle>(loadReplyStyle)

  useEffect(() => { applyReplyStyle(style) }, [style])

  const update = useCallback((next: ReplyStyle) => {
    saveReplyStyle(next)
    setStyle(next)
  }, [])

  return [style, update]
}
