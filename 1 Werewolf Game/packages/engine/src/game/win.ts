import type { Team } from '@ww/shared';
import { PUBLIC, emit, living } from './core';
import { SHERIFF_TITLE, behaviorOf } from './roles';
import type { Game, GameResult } from './types';

const SOLO_TEAMS: readonly Team[] = ['WhiteWolf', 'Piper', 'Lovers', 'Angel'];

/**
 * Parity rule (ruleset §4.3): the Werewolves also win when they are at least as many as
 * everyone else and nothing can still turn the game.
 */
export function parityHolds(g: Game): boolean {
  const alive = living(g);
  const wolves = alive.filter((s) => s.team === 'Werewolf').length;
  if (wolves === 0 || wolves < alive.length - wolves) return false;
  if (alive.some((s) => SOLO_TEAMS.includes(s.team))) return false;
  if (alive.some((s) => s.knightCursedAt !== null)) return false; // a pending Knight curse
  for (const s of alive) {
    if (s.team !== 'Village') continue;
    if (SHERIFF_TITLE.blocksParity(s)) return false;
    if (s.powersActive && behaviorOf(s.role).blocksParity?.(g, s)) return false;
  }
  return true;
}

/** The Angel died before Night 2 began (Night 1, Dawn 1, Day 1 or Dusk 1) while still on team Angel. */
function angelWon(g: Game) {
  return g.seats.find(
    (s) =>
      !s.alive &&
      s.role === 'angel' &&
      s.teamAtDeath === 'Angel' &&
      s.diedOn !== null &&
      s.diedOn.n === 1 &&
      (s.diedOn.phase === 'night' || s.diedOn.phase === 'dawn' || s.diedOn.phase === 'day' || s.diedOn.phase === 'dusk'),
  );
}

/**
 * Win table (ruleset §4.2), evaluated top to bottom; the first match ends the game.
 * Returns true when the game is over (and records the result).
 */
export function checkWin(g: Game): boolean {
  if (g.result) return true;
  // 0. Angel
  if (!g.angelRecordedWinner) {
    const angel = angelWon(g);
    if (angel) {
      if (g.cfg.rules.angel_ends_game) {
        finish(g, { winner: 'Angel', reason: 'the Angel died in the first round' });
        return true;
      }
      g.angelRecordedWinner = true;
      emit(g, 'ANGEL_RECORDED', { seat: angel.seat }, PUBLIC);
    }
  }
  const alive = living(g);
  let res: Omit<GameResult, 'winners'> | null = null;
  const piper = alive.find((s) => s.role === 'piper' && s.team === 'Piper');
  const loverAlive = alive.some((s) => s.loverId !== null);
  if (alive.length === 0) res = { winner: 'draw', reason: 'nobody alive' };
  else if (piper && alive.every((s) => s.seat === piper.seat || s.charmed)) res = { winner: 'Piper', reason: 'everyone else is charmed' };
  else if (loverAlive && alive.every((s) => s.team === 'Lovers')) res = { winner: 'Lovers', reason: 'only the Lovers remain' };
  else if (alive.length === 1 && alive[0]!.role === 'white_werewolf' && alive[0]!.team === 'WhiteWolf') res = { winner: 'WhiteWolf', reason: 'the White Werewolf is the last survivor' };
  else if (alive.every((s) => s.team === 'Werewolf')) res = { winner: 'Werewolf', reason: 'only werewolves remain' };
  else if (parityHolds(g)) res = { winner: 'Werewolf', reason: 'parity' };
  else if (alive.every((s) => s.team === 'Village')) res = { winner: 'Village', reason: 'all threats to the village are dead' };
  if (!res) return false;
  finish(g, res);
  return true;
}

/** Record the result; winners = every seat whose final team is the winning team (+ a recorded Angel). */
export function finish(g: Game, res: Omit<GameResult, 'winners'>): void {
  const winners = res.winner === 'draw' ? [] : g.seats.filter((s) => s.team === res.winner).map((s) => s.seat);
  if (g.angelRecordedWinner) {
    const angel = g.seats.find((s) => s.role === 'angel');
    if (angel && !winners.includes(angel.seat)) winners.push(angel.seat);
    winners.sort((a, b) => a - b);
  }
  g.result = { ...res, winners };
  g.phase = 'over';
  emit(g, 'GAME_OVER', { winner: res.winner, winners, reason: res.reason }, PUBLIC);
  emit(
    g,
    'FINAL_REVEAL',
    { seats: g.seats.map((s) => ({ seat: s.seat, role: s.role, originalRole: s.originalRole, team: s.team, alive: s.alive })) },
    PUBLIC,
  );
}
