// Phase 5 Chunk 6 — `admin_send_inbox`.
//
// Broadcasts an inbox message to a list of userIds via the existing
// `sendInbox` helper (Phase 5 Chunk 3). The `'all'` broadcast is
// deferred — see notes on the helper.
//
// Idempotency is inherited from `sendInbox` — re-sending the same
// `message.id` to the same user is a no-op (returns `inserted: false`).
// The caller can safely retry the broadcast.

import type { ILogger, INakama } from '../nkruntime';
import { sendInbox } from '../liveops/messages';
import { emitAdminAction } from '../core/admin/analytics';
import type {
  AdminSendInboxInput,
  AdminSendInboxOutput,
} from './types';

export interface SendInboxBulkResult {
  ok: boolean;
  error?: { code: string; message: string };
  data?: AdminSendInboxOutput;
}

export function sendInboxBulk(
  nk: INakama,
  logger: ILogger,
  input: AdminSendInboxInput,
): SendInboxBulkResult {
  if (input.userIds === 'all') {
    logger.warn('admin_send_inbox: broadcast-to-all deferred — bulk enumeration not implemented');
    return {
      ok: false,
      error: { code: 'NOT_IMPLEMENTED', message: "broadcast to 'all' is deferred; pass an explicit userIds[]" },
    };
  }
  if (!Array.isArray(input.userIds)) {
    return { ok: false, error: { code: 'BAD_REQUEST', message: 'userIds must be an array or the literal "all"' } };
  }
  if (input.userIds.length === 0) {
    return { ok: true, data: { delivered: 0 } };
  }
  if (input.message === undefined || typeof input.message.title !== 'string' || typeof input.message.body !== 'string') {
    return { ok: false, error: { code: 'BAD_REQUEST', message: 'message.title and message.body are required' } };
  }
  const messageId = nk.uuidv4();
  const nowMs = Date.now();
  let delivered = 0;
  for (const userId of input.userIds) {
    if (typeof userId !== 'string' || userId.length === 0) continue;
    const r = sendInbox(nk, userId, {
      id: messageId,
      kind: input.message.kind,
      title: input.message.title,
      body: input.message.body,
      ...(input.message.reward !== undefined ? { reward: input.message.reward } : {}),
      ...(input.message.expiresAt !== undefined ? { expiresAt: input.message.expiresAt } : {}),
    }, nowMs);
    if (r.inserted) delivered += 1;
  }
  emitAdminAction(nk, logger, 'admin_send_inbox', {
    recipientCount: input.userIds.length,
    delivered,
    messageId,
    kind: input.message.kind,
    title: input.message.title,
  });
  logger.warn('admin_send_inbox recipients=%d delivered=%d messageId=%s', input.userIds.length, delivered, messageId);
  return { ok: true, data: { delivered } };
}