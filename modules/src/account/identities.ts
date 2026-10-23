// Identities linked to an account, as Nakama 3.27 reports them
// (`accountGetId` → `accountToJsObject`).

import type { INakama } from '../nkruntime';
import type { LinkedProvider } from './types';

/** `accountGetId` shape in 3.27 (`accountToJsObject`): the fields read here. */
interface AccountView {
  user?: {
    userId?: string;
    displayName?: string;
    createTime?: number;
    appleId?: string;
    googleId?: string;
    facebookId?: string;
    facebookInstantGameId?: string;
    gamecenterId?: string;
    steamId?: string;
  };
  email?: string;
  customId?: string;
}

const USER_ID_FIELDS: ReadonlyArray<[LinkedProvider, keyof NonNullable<AccountView['user']>]> = [
  ['apple', 'appleId'],
  ['google', 'googleId'],
  ['facebook', 'facebookId'],
  ['facebook_instant_game', 'facebookInstantGameId'],
  ['gamecenter', 'gamecenterId'],
  ['steam', 'steamId'],
];

/**
 * Identities Nakama reports as linked to `userId`, or `null` when the
 * account does not exist (`accountGetId` throws).
 */
export function linkedProviders(nk: INakama, userId: string): LinkedProvider[] | null {
  let account: AccountView | null;
  try {
    account = nk.accountGetId(userId) as AccountView | null;
  } catch {
    return null;
  }
  if (account === null || account === undefined) return null;
  const out: LinkedProvider[] = [];
  for (const [provider, field] of USER_ID_FIELDS) {
    const v = account.user?.[field];
    if (typeof v === 'string' && v.length > 0) out.push(provider);
  }
  if (typeof account.email === 'string' && account.email.length > 0) out.push('email');
  if (typeof account.customId === 'string' && account.customId.length > 0) out.push('custom');
  return out;
}
