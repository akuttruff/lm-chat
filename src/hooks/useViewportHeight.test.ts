import { describe, it, expect } from 'vitest'
import { renderHook } from '@testing-library/react'
import useViewportHeight, { viewportMetrics } from './useViewportHeight.ts'

describe('viewportMetrics', () => {
  it('reads the visual viewport when there is one, else the window', () => {
    const vv = { height: 700.4, offsetTop: 12.6 } as VisualViewport
    const w = (over: object) => ({ innerHeight: 900, outerHeight: 900, navigator: {}, ...over }) as unknown as Window
    expect(viewportMetrics(w({ visualViewport: vv }))).toEqual({ height: 700, top: 13 })
    expect(viewportMetrics(w({ visualViewport: null }))).toEqual({ height: 900, top: 0 })
  })

  it('adds back the status bar an iOS home-screen app leaves out of every viewport height', () => {
    // Measured on an iPhone 13 mini: screen 812, every viewport 762, outerHeight 812.
    const phone = (over: object) => ({ innerHeight: 762, outerHeight: 812, navigator: { standalone: true }, visualViewport: { height: 762, offsetTop: 0 }, ...over }) as unknown as Window
    expect(viewportMetrics(phone({}))).toEqual({ height: 812, top: 0 })
    // With the keyboard up the visual viewport shrinks; the slack still applies.
    expect(viewportMetrics(phone({ visualViewport: { height: 462, offsetTop: 0 } }))).toEqual({ height: 512, top: 0 })
    // In Safari proper the toolbars explain the difference, and nothing is added.
    expect(viewportMetrics(phone({ navigator: {} }))).toEqual({ height: 762, top: 0 })
  })
})

describe('useViewportHeight', () => {
  it('writes the height to a CSS variable on <html>, and clears it on unmount', () => {
    const { unmount } = renderHook(() => useViewportHeight())
    expect(document.documentElement.style.getPropertyValue('--app-height')).toMatch(/^\d+px$/)
    expect(document.documentElement.style.getPropertyValue('--app-top')).toBe('0px')
    unmount()
    expect(document.documentElement.style.getPropertyValue('--app-height')).toBe('')
  })
})
