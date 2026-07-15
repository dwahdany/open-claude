// Global event bus + SSE encoding.
// Contract: docs/contract/02-events.md. Every frame is exactly `data: <single-line JSON>\n\n`
// (no event:/id:/retry: lines). Envelope: { directory, payload: { id: evt_..., type, properties } }.
// `workspace` is NEVER set (trap T2: setting it makes the TUI silently drop tui.*/session.error).
// First frame per connection is server.connected (no directory). Heartbeat every 10s.

import { Id } from "./ids"

export interface EventPayload {
  type: string
  properties: Record<string, unknown>
}

type Subscriber = (frame: string) => void

export class Bus {
  private subscribers = new Set<Subscriber>()
  readonly directory: string

  constructor(directory: string) {
    this.directory = directory
  }

  private encode(obj: unknown): string {
    return `data: ${JSON.stringify(obj)}\n\n`
  }

  /** Emit an event to all connected clients, wrapped in the GlobalEvent envelope.
   *  Session-scoped events pass the OWNING session's directory; default is the primary. */
  publish(type: string, properties: Record<string, unknown>, directory?: string): void {
    const frame = this.encode({
      directory: directory ?? this.directory,
      payload: { id: Id.event(), type, properties },
    })
    for (const sub of this.subscribers) sub(frame)
  }

  /** Register a client. Returns the initial frames to send and an unsubscribe fn. */
  subscribe(sub: Subscriber): { unsubscribe: () => void } {
    this.subscribers.add(sub)
    return { unsubscribe: () => this.subscribers.delete(sub) }
  }

  connectedFrame(): string {
    // server.connected has no directory field (handlers/global.ts:49).
    return this.encode({ payload: { id: Id.event(), type: "server.connected", properties: {} } })
  }

  heartbeatFrame(): string {
    return this.encode({ payload: { id: Id.event(), type: "server.heartbeat", properties: {} } })
  }
}
