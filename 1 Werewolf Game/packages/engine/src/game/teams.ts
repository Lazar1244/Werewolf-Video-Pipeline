import type { EnginePayload, SeatId, Team } from '@ww/shared';
import { emit, seatOf, toSeats } from './core';
import type { Game, SeatState } from './types';

type ChangeReason = EnginePayload<'ROLE_CHANGED'>['reason'];
type JoinReason = EnginePayload<'PACK_JOINED'>['reason'];

const packSeats = (g: Game): SeatId[] => g.seats.filter((s) => s.alive && s.wolfNature).map((s) => s.seat);

/**
 * Apply a team change (ruleset §4.1). Takes effect immediately and is announced privately.
 * A seat on team `Lovers` keeps that team (sticky) but still gains wolf nature.
 * Gaining wolf nature is announced to the Pack together with the newcomer's role.
 */
export function changeTeam(g: Game, s: SeatState, change: { team?: Team; wolfNature?: boolean }, reason: ChangeReason): void {
  const gainsWolf = change.wolfNature === true && !s.wolfNature;
  if (change.team && s.team !== 'Lovers') s.team = change.team;
  if (change.wolfNature !== undefined) s.wolfNature = change.wolfNature;
  if (s.role === 'piper' && s.team !== 'Piper') s.powersActive = false; // an infected / Lover Piper can no longer charm
  emit(g, 'ROLE_CHANGED', { seat: s.seat, role: s.role, team: s.team, wolfNature: s.wolfNature, reason }, toSeats([s.seat]));
  if (gainsWolf && reason !== 'thief' && s.alive) {
    const joinReason: JoinReason = reason === 'infected' ? 'infected' : reason === 'wolf_hound' ? 'wolf_hound' : 'wild_child';
    const pack = packSeats(g);
    emit(g, 'PACK_JOINED', { seat: s.seat, role: s.originalRole, reason: joinReason, pack }, toSeats(pack, 'pack')); // the newcomer learns the Pack list (§4.1)
  }
  evaluateLovers(g);
}

/** Wolf-Father infection (§8.2 step 1): joins the Werewolf team (unless a Lover), keeps its role. */
export function infect(g: Game, s: SeatState): void {
  s.infectedOn = g.night;
  emit(g, 'INFECTED', { seat: s.seat }, toSeats([s.seat]));
  changeTeam(g, s, { team: 'Werewolf', wolfNature: true }, 'infected');
}

/**
 * Lovers team evaluation (Cupid, §10): at the Lovers step on N1 and after every death batch
 * and team change. Cross-team pairs join team `Lovers` for good; when both Lovers are dead,
 * a non-Lover Cupid on team `Lovers` reverts to Werewolf/Village by its wolf nature.
 */
export function evaluateLovers(g: Game): void {
  if (g.cupid === null) return;
  const lovers = g.seats.filter((s) => s.loverId !== null);
  if (lovers.length !== 2) return;
  const [a, b] = lovers as [SeatState, SeatState];
  const cupid = seatOf(g, g.cupid);
  if (!g.loversCrossTeam && a.team !== b.team) {
    g.loversCrossTeam = true;
    const joiners = [a, b];
    if (cupid.alive && cupid.loverId === null && cupid.team === 'Village') joiners.push(cupid); // a dead seat's team never changes (§4.2)
    for (const s of joiners) {
      s.team = 'Lovers';
      if (s.role === 'piper') s.powersActive = false;
      emit(g, 'ROLE_CHANGED', { seat: s.seat, role: s.role, team: s.team, wolfNature: s.wolfNature, reason: 'lovers' }, toSeats([s.seat]));
    }
  }
  if (g.loversCrossTeam && !a.alive && !b.alive && cupid.loverId === null && cupid.team === 'Lovers') {
    cupid.team = cupid.wolfNature ? 'Werewolf' : 'Village';
    emit(g, 'ROLE_CHANGED', { seat: cupid.seat, role: cupid.role, team: cupid.team, wolfNature: cupid.wolfNature, reason: 'cupid_reverted' }, toSeats([cupid.seat]));
  }
}
