import { project, reduceView, type ViewEntry } from '@ww/projector';
import type { EngineEvent, Principal, SeatId } from '@ww/shared';

/**
 * What each principal may see (ARCHITECTURE.md §9.1). One predicate decides it for every read
 * path: while the lock is closed, nobody — not even the host — sees hidden information.
 */
export const canSeeHidden = (lockOpen: boolean): boolean => lockOpen;

export interface ProjectedView {
  entries: ViewEntry[];
  view: ReturnType<typeof reduceView>;
  lastVseq: number;
}

/**
 * What a browser is sent is the projection of the game minus the engine's request plumbing:
 * REQUEST_OPENED / REQUEST_CLOSED and the request number on a player's own thoughts carry the
 * engine's running request counter, whose gaps would count the secret night questions (§4.1).
 * The filter is the same for every call with the same principal, so `vseq` stays contiguous.
 */
function forBrowsers(events: readonly EngineEvent[]): EngineEvent[] {
  const out: EngineEvent[] = [];
  for (const e of events) {
    if (e.type === 'REQUEST_OPENED' || e.type === 'REQUEST_CLOSED') continue;
    if (e.type === 'SEAT_THOUGHTS' || e.type === 'FALLBACK_USED') {
      const { requestId: _drop, ...payload } = e.payload as { requestId?: number } & Record<string, unknown>;
      void _drop;
      out.push({ ...e, payload } as EngineEvent);
      continue;
    }
    out.push(e);
  }
  return out;
}

export function viewFor(allEvents: readonly EngineEvent[], principal: Principal, lockOpen: boolean): ProjectedView {
  const events = forBrowsers(allEvents);
  const entries =
    principal.kind === 'seat'
      ? project(events, { kind: 'seat', seat: principal.seat as SeatId }, lockOpen)
      : principal.kind === 'spectator'
        ? project(events, { kind: 'spectator' }, lockOpen)
        : // the host watches the public game until the lock opens, then everything
          project(events, { kind: lockOpen ? 'spectator' : 'public' }, lockOpen);
  const view = reduceView(entries, principal.kind === 'seat' ? (principal.seat as SeatId) : null);
  return { entries, view, lastVseq: entries.length };
}

/** Entries after `fromVseq` for the same viewer (the incremental feed). */
export function entriesSince(events: readonly EngineEvent[], principal: Principal, lockOpen: boolean, fromVseq: number): ViewEntry[] {
  return viewFor(events, principal, lockOpen).entries.filter((e) => e.vseq > fromVseq);
}

/**
 * Cost shown to the host while the lock is closed: rounded to 5% of the cap, so watching the
 * number cannot reveal how many calls a night needed (§9.1).
 */
export function hostSafeCost(spent: number, cap: number, lockOpen: boolean): number {
  if (lockOpen) return spent;
  const step = cap / 20;
  return Math.round(spent / step) * step;
}
