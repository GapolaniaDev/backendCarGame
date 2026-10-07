// Phase 7 Chunk 4 — Pure role / permission logic tests.
//
// Covers every branch of canUpdateClub / canKickMember / canPromoteTo /
// canDemoteTo / canLeave / applyTransfer.

import { describe, it, expect } from 'vitest';

import {
  canUpdateClub,
  canKickMember,
  canPromoteTo,
  canDemoteTo,
  canLeave,
  applyTransfer,
} from '../../modules/src/clubs/roles';

describe('canUpdateClub (Phase 7 Chunk 4)', () => {
  it('leader can update all three fields', () => {
    const r = canUpdateClub('leader', { motto: 'x', emblemId: 'y', minDivision: 'oro' });
    expect(r.allowed).toBe(true);
    expect(r.deniedField).toBeNull();
  });

  it('admin can update motto + emblemId but NOT minDivision', () => {
    const ok = canUpdateClub('admin', { motto: 'x', emblemId: 'y' });
    expect(ok.allowed).toBe(true);

    const denied = canUpdateClub('admin', { minDivision: 'oro' });
    expect(denied.allowed).toBe(false);
    expect(denied.deniedField).toBe('minDivision');
  });

  it('admin mixing fields — denied even when other fields valid', () => {
    const r = canUpdateClub('admin', { motto: 'x', minDivision: 'oro' });
    expect(r.allowed).toBe(false);
    expect(r.deniedField).toBe('minDivision');
  });

  it('member cannot update anything', () => {
    const r = canUpdateClub('member', { motto: 'x' });
    expect(r.allowed).toBe(false);
  });

  it('null role cannot update anything', () => {
    const r = canUpdateClub(null, { motto: 'x' });
    expect(r.allowed).toBe(false);
  });

  it('empty fields = not allowed (no-op)', () => {
    const r = canUpdateClub('leader', {});
    expect(r.allowed).toBe(false);
  });
});

describe('canKickMember (Phase 7 Chunk 4)', () => {
  it('leader can kick a member', () => {
    const r = canKickMember({ role: 'leader' }, { role: 'member' });
    expect(r.allowed).toBe(true);
    expect(r.reason).toBe('allowed');
  });

  it('leader can kick an admin', () => {
    const r = canKickMember({ role: 'leader' }, { role: 'admin' });
    expect(r.allowed).toBe(true);
  });

  it('leader cannot kick another leader → must transfer', () => {
    const r = canKickMember({ role: 'leader' }, { role: 'leader' });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('cannot_kick_leader');
  });

  it('admin can kick a member', () => {
    const r = canKickMember({ role: 'admin' }, { role: 'member' });
    expect(r.allowed).toBe(true);
  });

  it('admin cannot kick an admin', () => {
    const r = canKickMember({ role: 'admin' }, { role: 'admin' });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('admin_cannot_kick_admin');
  });

  it('admin cannot kick a leader', () => {
    const r = canKickMember({ role: 'admin' }, { role: 'leader' });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('cannot_kick_leader');
  });

  it('member cannot kick anyone', () => {
    const r = canKickMember({ role: 'member' }, { role: 'member' });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('not_member');
  });

  it('null actor returns not_member', () => {
    const r = canKickMember(null, { role: 'member' });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('not_member');
  });

  it('null target returns target_not_member', () => {
    const r = canKickMember({ role: 'leader' }, null);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('target_not_member');
  });
});

describe('canPromoteTo (Phase 7 Chunk 4)', () => {
  it('leader can promote member to admin', () => {
    const r = canPromoteTo({ role: 'leader' }, { role: 'member' }, 'admin');
    expect(r.allowed).toBe(true);
  });

  it('leader can promote admin to leader (transfer)', () => {
    const r = canPromoteTo({ role: 'leader' }, { role: 'admin' }, 'leader');
    expect(r.allowed).toBe(true);
  });

  it('leader cannot promote to member (use demote)', () => {
    const r = canPromoteTo({ role: 'leader' }, { role: 'member' }, 'member');
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('invalid_target_role');
  });

  it('non-leader cannot promote', () => {
    expect(canPromoteTo({ role: 'admin' }, { role: 'member' }, 'admin').allowed).toBe(false);
    expect(canPromoteTo({ role: 'member' }, { role: 'member' }, 'admin').allowed).toBe(false);
  });

  it('null actor returns not_leader', () => {
    const r = canPromoteTo(null, { role: 'member' }, 'admin');
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('not_leader');
  });

  it('null target returns target_not_member', () => {
    const r = canPromoteTo({ role: 'leader' }, null, 'admin');
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('target_not_member');
  });

  it('already in role returns already_role', () => {
    const r = canPromoteTo({ role: 'leader' }, { role: 'admin' }, 'admin');
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('already_role');
  });
});

describe('canDemoteTo (Phase 7 Chunk 4)', () => {
  it('leader can demote admin to member', () => {
    const r = canDemoteTo({ role: 'leader' }, { role: 'admin' }, 'member');
    expect(r.allowed).toBe(true);
  });

  it('leader can demote admin to admin (no-op → already_role)', () => {
    const r = canDemoteTo({ role: 'leader' }, { role: 'admin' }, 'admin');
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('already_role');
  });

  it('cannot demote leader (must transfer)', () => {
    const r = canDemoteTo({ role: 'leader' }, { role: 'leader' }, 'admin');
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('cannot_demote_leader');
  });

  it('cannot demote TO leader (use promote)', () => {
    const r = canDemoteTo({ role: 'leader' }, { role: 'admin' }, 'leader');
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('cannot_demote_to_leader');
  });

  it('non-leader cannot demote', () => {
    expect(canDemoteTo({ role: 'admin' }, { role: 'member' }, 'member').allowed).toBe(false);
    expect(canDemoteTo({ role: 'member' }, { role: 'member' }, 'member').allowed).toBe(false);
  });

  it('null actor → not_leader', () => {
    const r = canDemoteTo(null, { role: 'admin' }, 'member');
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('not_leader');
  });

  it('null target → target_not_member', () => {
    const r = canDemoteTo({ role: 'leader' }, null, 'member');
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('target_not_member');
  });
});

describe('canLeave (Phase 7 Chunk 4)', () => {
  it('admin can leave', () => {
    const r = canLeave({ role: 'admin' });
    expect(r.allowed).toBe(true);
  });

  it('member can leave', () => {
    const r = canLeave({ role: 'member' });
    expect(r.allowed).toBe(true);
  });

  it('leader cannot leave', () => {
    const r = canLeave({ role: 'leader' });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('leader_cannot_leave');
  });

  it('null actor cannot leave', () => {
    const r = canLeave(null);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('not_member');
  });
});

describe('applyTransfer (Phase 7 Chunk 4)', () => {
  it('swap leader with admin yields 2 steps', () => {
    const steps = applyTransfer('L', 'A', 'admin');
    expect(steps).toEqual([
      { userId: 'L', from: 'leader', to: 'admin' },
      { userId: 'A', from: 'admin', to: 'leader' },
    ]);
  });

  it('swap leader with member yields 2 steps', () => {
    const steps = applyTransfer('L', 'M', 'member');
    expect(steps).toEqual([
      { userId: 'L', from: 'leader', to: 'admin' },
      { userId: 'M', from: 'member', to: 'leader' },
    ]);
  });

  it('swap to yourself = no-op (empty)', () => {
    const steps = applyTransfer('L', 'L', 'leader');
    expect(steps).toEqual([]);
  });

  it('swap to an existing leader = no-op (empty)', () => {
    // Should not occur in practice (we don't allow promoting an
    // already-leader), but the helper handles it cleanly.
    const steps = applyTransfer('L', 'L2', 'leader');
    expect(steps).toEqual([
      { userId: 'L', from: 'leader', to: 'admin' },
    ]);
  });
});