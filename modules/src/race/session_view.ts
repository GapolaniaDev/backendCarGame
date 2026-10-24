// What a player may see of a race session (plan fishnet-nakama-server, D-05).
//
// A dedicated-server session stores one `joinTicket` per roster entry. The
// ticket is the player's credential for the race server, so no response
// ever carries the tickets of the roster: the caller only gets their own,
// as `myJoinTicket`, beside the address of the server.

import type { RaceSession, RaceSessionGetOutput, RosterEntry } from './types';

/** The session without the join tickets of its roster. */
export function withoutJoinTickets(session: RaceSession): RaceSession {
  if (!session.roster.some((e) => e.joinTicket !== undefined)) return session;
  return {
    ...session,
    roster: session.roster.map((e) => {
      if (e.joinTicket === undefined) return e;
      const publicEntry: RosterEntry = { ...e };
      delete publicEntry.joinTicket;
      return publicEntry;
    }),
  };
}

/**
 * Finishes a `race_session_get` response for `callerId`: strips every
 * `joinTicket` from the sessions in it and, for a dedicated-server session
 * that is not closed, adds `server` and the caller's own `myJoinTicket`.
 */
export function toPublicSessionOutput(out: RaceSessionGetOutput, callerId: string): RaceSessionGetOutput {
  const result: RaceSessionGetOutput = { session: withoutJoinTickets(out.session) };
  if (out.lastClosed !== undefined) result.lastClosed = withoutJoinTickets(out.lastClosed);
  const { session } = out;
  if (session.serverHosted === true && session.server !== undefined && session.state !== 'closed') {
    result.server = { host: session.server.host, port: session.server.port };
    const mine = session.roster.find((e) => e.userId === callerId)?.joinTicket;
    if (mine !== undefined) result.myJoinTicket = mine;
  }
  return result;
}
