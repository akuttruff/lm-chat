import type { ServerResponse } from 'node:http'
import type { Conversation } from '../src/types.ts'

/**
 * A tiny pub/sub so every connected client sees the same conversation state.
 * The UI is a subscriber: it renders what the server reports rather than
 * tracking a turn itself.
 */
export type BusEvent =
  | { type: 'conversations'; payload: unknown }
  | { type: 'conversation'; payload: Conversation }
  | { type: 'status'; payload: { conversationId: string; state: string; text: string; startedAt: number | null } }

/**
 * How much unsent data a client may accumulate before it is cut loose.
 *
 * A phone that locks mid-reply often leaves its connection open but stops
 * reading it. Node then buffers every frame written to that socket, without
 * limit -- and a long reply produces thousands of them. That filled the
 * server's 4 GB heap and crashed it. A client that falls this far behind is
 * disconnected instead; EventSource reconnects on its own when the phone
 * wakes, and the first frame on a new connection is the complete state, so
 * nothing is lost by dropping the backlog.
 */
export const MAX_BACKLOG_BYTES = 4 * 1024 * 1024

export class Bus {
  private clients = new Set<ServerResponse>()

  add(res: ServerResponse): () => void {
    this.clients.add(res)
    return () => this.clients.delete(res)
  }

  get size(): number {
    return this.clients.size
  }

  send(event: BusEvent): void {
    const frame = `data: ${JSON.stringify(event)}\n\n`
    for (const res of this.clients) {
      if (res.destroyed || res.writableEnded || res.writableLength > MAX_BACKLOG_BYTES) {
        this.clients.delete(res)
        res.destroy()
        continue
      }
      try {
        res.write(frame)
      } catch {
        this.clients.delete(res)
      }
    }
  }
}
