import type { SeatId } from '@ww/shared';
import { PUBLIC, emit, living, livingNeighbours, seatOf } from './core';
import { speak } from './day';
import { drainTriggers, killBatch, type DeathEntry } from './deaths';
import type { NightActions } from './night';
import { infect } from './teams';
import type { Game } from './types';
import { checkWin } from './win';

/**
 * Absorption order for an attack (ruleset §8.1): Protector (nothing consumed), then the
 * Elder's extra life (consumed), then — for V only — the Witch's heal (already consumed
 * when she chose it). The first saver that applies absorbs the attack.
 */
function absorbed(g: Game, na: NightActions, seat: SeatId, isV: boolean): boolean {
  if (na.protectedSeat === seat) return true;
  const s = seatOf(g, seat);
  if (s.role === 'elder' && (s.uses.elder_life ?? 0) > 0) {
    s.uses.elder_life = 0;
    return true;
  }
  return isV && na.healed;
}

/** Dawn k (ruleset §8.2). Returns true when the game is over. */
export function dawn(g: Game, na: NightActions): boolean {
  g.phase = 'dawn';
  emit(g, 'PHASE_START', { phase: 'dawn', night: g.night }, PUBLIC);
  const entries: DeathEntry[] = [];
  const knightsKilled: SeatId[] = [];
  const knightCheck = (seat: SeatId) => {
    const s = seatOf(g, seat);
    if (s.role === 'knight' && s.powersActive) knightsKilled.push(seat);
  };

  // 1. V: kill or infection
  if (na.victim !== null) {
    const isAbsorbed = absorbed(g, na, na.victim, true);
    const wf = g.seats.find((s) => s.role === 'accursed_wolf_father');
    if (na.infect && wf && (!isAbsorbed || g.cfg.rules.infection_consumed_on_fail)) wf.uses.infect = 0;
    if (!isAbsorbed) {
      if (na.infect) infect(g, seatOf(g, na.victim));
      else {
        entries.push({ seat: na.victim, cause: { tag: 'attack' } });
        knightCheck(na.victim);
      }
    }
  }
  // 2. B: the Big Bad Wolf's victim
  if (na.bbwVictim !== null && !absorbed(g, na, na.bbwVictim, false)) {
    entries.push({ seat: na.bbwVictim, cause: { tag: 'bbw' } });
    knightCheck(na.bbwVictim);
  }
  // 3. W: the White Werewolf's victim (only the Protector saves)
  if (na.wwVictim !== null && na.protectedSeat !== na.wwVictim) entries.push({ seat: na.wwVictim, cause: { tag: 'white_wolf' } });
  // 4. P: poison (nothing absorbs it)
  if (na.poisoned !== null) entries.push({ seat: na.poisoned, cause: { tag: 'poison', byTeam: na.poisonByTeam ?? 'Village' } });
  // Knight curse placement (after step 4): nearest living wolf-nature seat to the Knight's left that is not in
  // this Dawn's batch. The batch includes step-5 curse victims and everyone its heartbreak closure takes (§8.2).
  const dying = new Set(entries.map((e) => e.seat));
  for (const s of living(g)) if (s.knightCursedAt !== null && s.knightCursedAt < g.night) dying.add(s.seat);
  for (let changed = true; changed; ) {
    changed = false;
    for (const d of [...dying]) {
      const partner = seatOf(g, d).loverId;
      if (partner !== null && seatOf(g, partner).alive && !dying.has(partner)) {
        dying.add(partner);
        changed = true;
      }
    }
  }
  for (const k of knightsKilled) {
    const n = g.seats.length;
    for (let i = 1; i < n; i++) {
      const s = g.seats[(k - 1 + i) % n]!;
      if (s.alive && s.wolfNature && !dying.has(s.seat)) {
        s.knightCursedAt = g.night;
        break;
      }
    }
  }
  // 5. Knight curse from an earlier night
  for (const s of living(g)) {
    if (s.knightCursedAt !== null && s.knightCursedAt < g.night) {
      entries.push({ seat: s.seat, cause: { tag: 'knight_curse' } });
      s.knightCursedAt = null;
    }
  }
  // 5b. Scapegoat bans take effect today
  for (const s of g.seats) {
    s.voteBannedToday = s.voteBannedNextDay;
    s.voteBannedNextDay = false;
  }
  // night_last_words (default off): victims speak before the deaths are revealed
  if (g.cfg.rules.night_last_words) {
    for (const n of [...new Set(entries.map((e) => e.seat))].sort((a, b) => a - b)) if (seatOf(g, n).alive) speak(g, n, 'last_words', null);
  }
  // 6. death batch + trigger queue
  const died = killBatch(g, entries);
  if (died.length === 0) emit(g, 'NO_DEATHS', {}, PUBLIC);
  drainTriggers(g);
  // 7. public dawn notices
  if (g.ravenMark !== null && seatOf(g, g.ravenMark).alive) emit(g, 'RAVEN_MARK', { seat: g.ravenMark }, PUBLIC);
  else g.ravenMark = null;
  const tamer = g.seats.find((s) => s.alive && s.role === 'bear_tamer' && s.powersActive);
  if (tamer) {
    const growls = tamer.wolfNature || livingNeighbours(g, tamer.seat).some((n) => seatOf(g, n).wolfNature);
    emit(g, 'BEAR', { growls }, PUBLIC);
  }
  // 8. private notices were sent when they happened (infection, conversions); 9. win check
  return checkWin(g);
}
