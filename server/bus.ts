import type { ServerResponse } from 'node:http'
import type { Conversation, ConversationMeta, Message } from '../src/types.ts'

/**
 * A tiny pub/sub so every connected client sees the same conversation state.
 * The UI is a subscriber: it renders what the server reports rather than
 * tracking a turn itself.
 */
/**
 * Events are as small as the change. A conversation can run to a megabyte
 * of tool output, and sending the whole store for every switch -- or the
 * whole thread several times a second while a reply streamed -- left a phone
 * parsing megabytes on its main thread and too busy to respond to a tap.
 */
export type BusEvent =
  /** The full store: on connect, and after a bulk replace. */
  | { type: 'conversations'; payload: unknown }
  /** Which thread is open. */
  | { type: 'active'; payload: { activeId: string | null } }
  /**
   * A reply in progress: every message from `base` on, plus the thread's
   * metadata. Messages before `base` are unchanged.
   */
  | { type: 'tail'; payload: { conversationId: string; base: number; messages: Message[]; meta: ConversationMeta } }
  /** A thread's metadata changed -- name, reasoning, summary -- never its messages. */
  | { type: 'patch'; payload: { conversationId: string; meta: ConversationMeta } }
  | { type: 'created'; payload: { conversation: Conversation; activeId: string | null } }
  | { type: 'removed'; payload: { conversationId: string; activeId: string | null; replacement?: Conversation } }
  | { type: 'status'; payload: { conversationId: string; state: string; text: string; startedAt: number | null } }
  | { type: 'statuses'; payload: { conversationId: string; state: string; text: string; startedAt: number | null }[] }

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
