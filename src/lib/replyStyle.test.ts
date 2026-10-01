import { describe, it, expect } from 'vitest'
import { DEFAULT_REPLY_STYLE, applyReplyStyle, loadReplyStyle, saveReplyStyle } from './replyStyle'

describe('replyStyle', () => {
  it('defaults when nothing is saved', () => {
    expect(loadReplyStyle()).toEqual(DEFAULT_REPLY_STYLE)
  })

  it('round-trips through this device\'s storage', () => {
    saveReplyStyle({ font: 'serif', size: 'large' })
    expect(loadReplyStyle()).toEqual({ font: 'serif', size: 'large' })
  })

  it('falls back field by field on a garbled or outdated value', () => {
    localStorage.setItem('lm-chat.replyStyle', JSON.stringify({ font: 'comic-sans', size: 'large' }))
    expect(loadReplyStyle()).toEqual({ font: 'system', size: 'large' })
    localStorage.setItem('lm-chat.replyStyle', 'not json')
    expect(loadReplyStyle()).toEqual(DEFAULT_REPLY_STYLE)
  })

  it('puts the choice on the document for the stylesheet to read', () => {
    applyReplyStyle({ font: 'mono', size: 'small' })
    expect(document.documentElement.dataset.replyFont).toBe('mono')
    expect(document.documentElement.dataset.replySize).toBe('small')
  })
})
