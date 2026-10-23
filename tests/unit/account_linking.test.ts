// Native account linking (plan T-15, P-02): the link bonus and the
// conflict flow over identities Nakama verified. No link token exists
// any more, so nothing here signs one.

import { describe, it, expect } from 'vitest';
import { FakeNakama, FakeLogger } from '../e2e/_stubs';
import { claimLinkBonus, openConflict, resolveConflict } from '../../modules/src/account/linking';
import { linkedProviders } from '../../modules/src/account/identities';
import { ACCOUNT_LINK_CONFLICT_TTL_MS } from '../../modules/src/account/types';

const SOURCE = 'user-source';
const TARGET = 'user-target';
const NOW = 1_700_000_000_000;

function setup(): { nak: FakeNakama; logger: FakeLogger } {
  return { nak: new FakeNakama(), logger: new FakeLogger() };
}

describe('linkedProviders — accountGetId as 3.27 reports it', () => {
  it('lists provider ids, email and custom id; devices are not links', () => {
    const { nak } = setup();
    nak.linkIdentity(SOURCE, 'devices', 'device-1');
    expect(linkedProviders(nak.nakama, SOURCE)).toEqual([]);
    nak.linkIdentity(SOURCE, 'googleId', 'g-1');
    nak.linkIdentity(SOURCE, 'email', 'a@example.com');
    nak.linkIdentity(SOURCE, 'customId', 'c-1');
    expect(linkedProviders(nak.nakama, SOURCE)).toEqual(['google', 'email', 'custom']);
  });

  it('is null for a deleted account', () => {
    const { nak } = setup();
    nak.nakama.accountDeleteId(SOURCE, false);
    expect(linkedProviders(nak.nakama, SOURCE)).toBeNull();
  });
});

describe('claimLinkBonus', () => {
  it('credits 500 coins once and seals the profile flag in the same movement', () => {
    const { nak, logger } = setup();
    const first = claimLinkBonus(nak.nakama, logger, SOURCE, NOW);
    expect(first).toEqual({ ok: true, data: { bonusClaimed: true, newBalance: { coins: 500, gems: 0 } } });
    const profile = nak.store.get(`profiles/${SOURCE}/${SOURCE}`)?.value as { accountLinkBonusClaimed?: boolean };
    expect(profile.accountLinkBonusClaimed).toBe(true);

    const second = claimLinkBonus(nak.nakama, logger, SOURCE, NOW);
    expect(second).toEqual({ ok: true, data: { bonusClaimed: false } });
    expect(nak.wallets.get(SOURCE)?.['coins']).toBe(500);
  });

  it('a replayed key (flag lost) still pays nothing', () => {
    const { nak, logger } = setup();
    expect(claimLinkBonus(nak.nakama, logger, SOURCE, NOW).ok).toBe(true);
    const key = `profiles/${SOURCE}/${SOURCE}`;
    const obj = nak.store.get(key)!;
    nak.store.set(key, { ...obj, value: { ...(obj.value as object), accountLinkBonusClaimed: false } });
    expect(claimLinkBonus(nak.nakama, logger, SOURCE, NOW)).toEqual({ ok: true, data: { bonusClaimed: false } });
    expect(nak.wallets.get(SOURCE)?.['coins']).toBe(500);
  });
});

describe('conflict flow', () => {
  it('open needs a linked identity on the caller (the target)', () => {
    const { nak, logger } = setup();
    const r = openConflict(nak.nakama, logger, TARGET, NOW);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('CONFLICT');
    expect(r.error.details).toEqual({ reason: 'NOT_LINKED' });
  });

  it('open → resolve link deletes the real target; the identity can be linked again', () => {
    const { nak, logger } = setup();
    nak.linkIdentity(TARGET, 'googleId', 'g-shared');
    nak.wallets.set(TARGET, { coins: 70, gems: 3 });
    expect(() => nak.linkIdentity(SOURCE, 'googleId', 'g-shared')).toThrow(/already in use/);

    const opened = openConflict(nak.nakama, logger, TARGET, NOW);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.data.target.userId).toBe(TARGET);
    expect(opened.data.target.profile.coins).toBe(70);

    const noConfirm = resolveConflict(nak.nakama, logger, SOURCE, { conflictToken: opened.data.conflictToken, choice: 'link' }, NOW);
    expect(noConfirm.ok).toBe(false);

    const r = resolveConflict(
      nak.nakama, logger, SOURCE,
      { conflictToken: opened.data.conflictToken, choice: 'link', confirmText: 'TRANSFER' },
      NOW + 1000,
    );
    expect(r).toEqual({ ok: true, data: { resolved: 'linked', affectedAccountDeleted: true, relinkProviders: ['google'] } });
    expect(nak.deletedAccounts.has(TARGET)).toBe(true);
    expect(nak.deletedAccounts.has(SOURCE)).toBe(false);
    nak.linkIdentity(SOURCE, 'googleId', 'g-shared');
    expect(nak.findIdentityOwner('googleId', 'g-shared')).toBe(SOURCE);
    // The token is single use.
    const again = resolveConflict(
      nak.nakama, logger, SOURCE,
      { conflictToken: opened.data.conflictToken, choice: 'link', confirmText: 'TRANSFER' },
      NOW + 2000,
    );
    expect(again.ok).toBe(false);
  });

  it('cancel keeps both accounts', () => {
    const { nak, logger } = setup();
    nak.linkIdentity(TARGET, 'customId', 'c-shared');
    const opened = openConflict(nak.nakama, logger, TARGET, NOW);
    if (!opened.ok) throw new Error('open failed');
    const r = resolveConflict(nak.nakama, logger, SOURCE, { conflictToken: opened.data.conflictToken, choice: 'cancel' }, NOW);
    expect(r).toEqual({ ok: true, data: { resolved: 'cancelled' } });
    expect(nak.findIdentityOwner('customId', 'c-shared')).toBe(TARGET);
  });

  it('the target cannot resolve its own deletion', () => {
    const { nak, logger } = setup();
    nak.linkIdentity(TARGET, 'customId', 'c-shared');
    const opened = openConflict(nak.nakama, logger, TARGET, NOW);
    if (!opened.ok) throw new Error('open failed');
    const r = resolveConflict(
      nak.nakama, logger, TARGET,
      { conflictToken: opened.data.conflictToken, choice: 'link', confirmText: 'TRANSFER' },
      NOW,
    );
    expect(r.ok).toBe(false);
    expect(nak.deletedAccounts.has(TARGET)).toBe(false);
  });

  it('unknown and expired tokens → NOT_FOUND', () => {
    const { nak, logger } = setup();
    nak.linkIdentity(TARGET, 'customId', 'c-shared');
    const unknown = resolveConflict(nak.nakama, logger, SOURCE, { conflictToken: 'nope', choice: 'cancel' }, NOW);
    expect(unknown.ok ? 'ok' : unknown.error.code).toBe('NOT_FOUND');
    const opened = openConflict(nak.nakama, logger, TARGET, NOW);
    if (!opened.ok) throw new Error('open failed');
    const late = resolveConflict(
      nak.nakama, logger, SOURCE,
      { conflictToken: opened.data.conflictToken, choice: 'link', confirmText: 'TRANSFER' },
      NOW + ACCOUNT_LINK_CONFLICT_TTL_MS + 1,
    );
    expect(late.ok ? 'ok' : late.error.code).toBe('NOT_FOUND');
    expect(nak.deletedAccounts.has(TARGET)).toBe(false);
  });
});
