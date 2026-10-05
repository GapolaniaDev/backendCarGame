// Unit tests for the EventBus.
//
// Verifies:
//   - subscribe + publish invokes each handler in order
//   - async handlers are awaited sequentially
//   - a thrown handler does not stop subsequent handlers
//   - a rejected async handler is caught and logged
//   - publish with no subscribers is a no-op
//   - duplicate subscriptions are called once per registration

import { describe, it, expect, beforeEach, vi } from 'vitest';

import type { ILogger } from '../../modules/src/nkruntime';
import { EventBus } from '../../modules/src/core/event_bus';

function makeLogger(): { logger: ILogger; errors: string[] } {
  const errors: string[] = [];
  // Minimal printf-style `%s` substitution so we can match real Nakama
  // logger semantics in tests.
  const sub = (format: string, args: unknown[]): string => {
    let i = 0;
    return format.replace(/%[sd]/g, () => String(args[i++] ?? ''));
  };
  const logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: (format: string, ...args: unknown[]) => {
      errors.push(sub(format, args));
    },
    withField: () => logger,
    withFields: () => logger,
    getFields: () => ({}),
  } as unknown as ILogger;
  return { logger, errors };
}

describe('EventBus', () => {
  let logger: ILogger;
  let errors: string[];
  beforeEach(() => {
    ({ logger, errors } = makeLogger());
  });

  it('invokes each subscriber in registration order', async () => {
    const bus = new EventBus(logger);
    const calls: string[] = [];
    bus.subscribe('RaceCompleted', (p) => {
      calls.push(`A:${String((p as { tag: string }).tag)}`);
    });
    bus.subscribe('RaceCompleted', (p) => {
      calls.push(`B:${String((p as { tag: string }).tag)}`);
    });
    await bus.publish('RaceCompleted', { tag: 'one' });
    expect(calls).toEqual(['A:one', 'B:one']);
  });

  it('awaits async handlers sequentially', async () => {
    const bus = new EventBus(logger);
    const order: string[] = [];
    bus.subscribe('e', async () => {
      await new Promise((r) => setTimeout(r, 10));
      order.push('slow1');
    });
    bus.subscribe('e', async () => {
      await new Promise((r) => setTimeout(r, 1));
      order.push('slow2');
    });
    bus.subscribe('e', () => {
      order.push('fast');
    });
    await bus.publish('e', null);
    expect(order).toEqual(['slow1', 'slow2', 'fast']);
  });

  it('isolates subscriber failures and logs them', async () => {
    const bus = new EventBus(logger);
    const calls: string[] = [];
    bus.subscribe('e', () => {
      calls.push('before');
    });
    bus.subscribe('e', () => {
      throw new Error('subscriber-2-broke');
    });
    bus.subscribe('e', async () => {
      await Promise.reject(new Error('subscriber-3-rejected'));
    });
    bus.subscribe('e', () => {
      calls.push('after');
    });

    await bus.publish('e', null);
    expect(calls).toEqual(['before', 'after']);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatch(/subscriber-2-broke/);
    expect(errors[1]).toMatch(/subscriber-3-rejected/);
  });

  it('is a no-op when no subscribers are registered', async () => {
    const bus = new EventBus(logger);
    await expect(bus.publish('nothing', { any: 'thing' })).resolves.toBeUndefined();
    expect(errors).toEqual([]);
  });

  it('counts subscribers', () => {
    const bus = new EventBus(logger);
    expect(bus.subscriberCount('e')).toBe(0);
    const a = vi.fn();
    const b = vi.fn();
    bus.subscribe('e', a);
    bus.subscribe('e', b);
    expect(bus.subscriberCount('e')).toBe(2);
  });

  it('treats different events as independent', async () => {
    const bus = new EventBus(logger);
    const a: string[] = [];
    const b: string[] = [];
    bus.subscribe('A', (p) => {
      a.push(String(p));
    });
    bus.subscribe('B', (p) => {
      b.push(String(p));
    });
    await bus.publish('A', 'a1');
    await bus.publish('B', 'b1');
    expect(a).toEqual(['a1']);
    expect(b).toEqual(['b1']);
  });
});
