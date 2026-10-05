// In-process event bus used to broadcast server-internal events (e.g.
// `RaceCompleted`) between TypeScript modules within a single bundle.
//
// The Nakama 3.27 JS runtime does NOT expose a module-to-module event API
// (verified — the only `event()` binding is for client sockets). So we
// implement a simple synchronous, in-process pub/sub here.
//
// Subscribers run sequentially in subscription order. Each subscriber is
// wrapped in try/catch — failures are logged and do not block subsequent
// subscribers. This matches the Phase 1 spec's "si un suscriptor falla,
// se registra y los demás continúan".

import type { ILogger } from '../nkruntime';

export type EventHandler = (payload: unknown) => void | Promise<void>;

export class EventBus {
  private readonly subscribers = new Map<string, EventHandler[]>();

  constructor(private readonly logger: ILogger) {}

  subscribe(eventName: string, handler: EventHandler): void {
    const list = this.subscribers.get(eventName);
    if (list) {
      list.push(handler);
    } else {
      this.subscribers.set(eventName, [handler]);
    }
  }

  /**
   * Synchronously invokes each subscriber in registration order. Subscriber
   * exceptions are caught and logged with the event name so a single broken
   * handler cannot stop the rest. Promise rejections from async handlers
   * are caught the same way (awaited sequentially).
   */
  async publish(eventName: string, payload: unknown): Promise<void> {
    const list = this.subscribers.get(eventName);
    if (!list || list.length === 0) return;
    for (let i = 0; i < list.length; i++) {
      const handler = list[i];
      if (!handler) continue;
      try {
        await handler(payload);
      } catch (err) {
        this.logger.error(
          'event subscriber failed [event=%s index=%d]: %s',
          eventName,
          i,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  }

  /** Test/diagnostic helper — number of subscribers for a given event. */
  subscriberCount(eventName: string): number {
    return this.subscribers.get(eventName)?.length ?? 0;
  }
}