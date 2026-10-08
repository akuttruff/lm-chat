import { describe, it, expect } from 'vitest'
import { renderHook } from '@testing-library/react'
import useViewportHeight, { viewportMetrics } from './useViewportHeight.ts'

describe('viewportMetrics', () => {
  it('reads the visual viewport when there is one, else the window', () => {
    const vv = { height: 700.4, offsetTop: 12.6 } as VisualViewport
    expect(viewportMetrics({ visualViewport: vv, innerHeight: 900 } as unknown as Window)).toEqual({ height: 700, top: 13 })
    expect(viewportMetrics({ visualViewport: null, innerHeight: 900 } as unknown as Window)).toEqual({ height: 900, top: 0 })
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
