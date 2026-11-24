import { vi } from 'vitest'

/** A controllable EventSource stand-in for tests. */
export class FakeEventSource {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 2
  static instances: FakeEventSource[] = []
  onopen: (() => void) | null = null
  onmessage: ((e: MessageEvent<string>) => void) | null = null
  onerror: (() => void) | null = null
  readyState = FakeEventSource.CONNECTING
  closed = false
  private listeners = new Map<string, ((e: MessageEvent<string>) => void)[]>()

  constructor(public url: string) {
    FakeEventSource.instances.push(this)
  }

  addEventListener(name: string, fn: (e: MessageEvent<string>) => void): void {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), fn])
  }

  close(): void {
    this.closed = true
    this.readyState = FakeEventSource.CLOSED
  }

  /** The connection opens. */
  open(): void {
    this.readyState = FakeEventSource.OPEN
    this.onopen?.()
  }

  /** Deliver a server event to the subscriber. */
  emit(event: unknown): void {
    this.onmessage?.({ data: JSON.stringify(event) } as MessageEvent<string>)
  }

  /** Deliver a named event (`ping`, or an app's own). */
  emitNamed(name: string, data = '1'): void {
    for (const fn of this.listeners.get(name) ?? []) fn({ data } as MessageEvent<string>)
  }

  /** The connection fails: `closed` when the browser gives up rather than retrying. */
  fail(closed = false): void {
    this.readyState = closed ? FakeEventSource.CLOSED : FakeEventSource.CONNECTING
    this.onerror?.()
  }

  static latest(): FakeEventSource {
    return FakeEventSource.instances.at(-1)!
  }

  static reset(): void {
    FakeEventSource.instances = []
  }
}

export function stubEventSource(): typeof FakeEventSource {
  FakeEventSource.reset()
  vi.stubGlobal('EventSource', FakeEventSource)
  return FakeEventSource
}
