import { vi } from 'vitest'

/** A controllable EventSource stand-in for tests. */
export class FakeEventSource {
  static instances: FakeEventSource[] = []
  onopen: (() => void) | null = null
  onmessage: ((e: MessageEvent<string>) => void) | null = null
  onerror: (() => void) | null = null
  closed = false

  constructor(public url: string) {
    FakeEventSource.instances.push(this)
  }

  close(): void { this.closed = true }

  /** Deliver a server event to the subscriber. */
  emit(event: unknown): void {
    this.onmessage?.({ data: JSON.stringify(event) } as MessageEvent<string>)
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
