import type { ChannelLabel, EngineEvent, EngineEventType, GameTime, SeatId } from '@ww/shared';

/**
 * Projector (ARCHITECTURE.md §6.1): filters the engine log for one viewer.
 * Pure and browser-safe; the server, the ContextBuilder and the web UI share it.
 */
export type Viewer = { kind: 'seat'; seat: SeatId } | { kind: 'public' } | { kind: 'spectator' };

export interface ViewEntry {
  /** Contiguous per viewer (clients never see `eseq`, so gaps cannot reveal hidden activity). */
  vseq: number;
  at: GameTime;
  type: EngineEventType;
  payload: unknown;
  /** Private-channel label (pack / sisters / lovers / charmed), when the event has one. */
  channel?: ChannelLabel;
  /** True when the entry was addressed to specific seats rather than everyone. */
  private?: boolean;
  /**
   * Who a private entry was addressed to. Safe to carry: an entry only ever reaches a seat that
   * is itself on this list, and the others are then its channel — a pack, a pair of Lovers or
   * sisters — whose members already know each other. It is what lets a reader be told that a
   * second-person notice ("You are the Seer") belongs to someone else.
   */
  seats?: readonly SeatId[];
}

/** Whether one event reaches a viewer. Before the lock opens a spectator gets the public view. */
export function visibleTo(e: EngineEvent, viewer: Viewer, lockOpen: boolean): boolean {
  switch (viewer.kind) {
    case 'spectator':
      return lockOpen || e.vis.kind === 'public';
    case 'public':
      return e.vis.kind === 'public';
    case 'seat':
      return e.vis.kind === 'public' || (e.vis.kind === 'seats' && e.vis.seats.includes(viewer.seat));
  }
}

export function project(events: readonly EngineEvent[], viewer: Viewer, lockOpen: boolean): ViewEntry[] {
  const out: ViewEntry[] = [];
  for (const e of events) {
    if (!visibleTo(e, viewer, lockOpen)) continue;
    const at: GameTime = { phase: e.at.phase, day: e.at.day, night: e.at.night };
    // Night sub-steps are removed from seat and public views (ruleset §7.1): only spectators see them.
    if (viewer.kind === 'spectator' && e.at.step !== undefined) at.step = e.at.step;
    const entry: ViewEntry = { vseq: out.length + 1, at, type: e.type as EngineEventType, payload: e.payload };
    if (e.vis.kind === 'seats') {
      entry.private = true;
      entry.seats = e.vis.seats;
      if (e.vis.channel) entry.channel = e.vis.channel;
    }
    out.push(entry);
  }
  return out;
}
