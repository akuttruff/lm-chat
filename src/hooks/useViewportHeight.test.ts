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
