import type { DecisionOf, EnginePayload, SeatId } from '@ww/shared';
import { PUBLIC, SPECTATOR, ask, emit, livingSeats, seatOf } from './core';
import { SHERIFF_TITLE, behaviorOf } from './roles';
import { changeTeam, evaluateLovers } from './teams';
import type { DeathCause, Game } from './types';

export interface DeathEntry {
  seat: SeatId;
  cause: DeathCause;
}

/** What the table learns about a dead player (ruleset §8.3 step 4). */
export function revealOf(g: Game, seat: SeatId): EnginePayload<'DEATHS'>['deaths'][number]['reveal'] {
  const s = seatOf(g, seat);
  switch (g.cfg.rules.reveal_on_death) {
    case 'full':
      return s.infectedOn !== null ? { role: s.originalRole, infected: true } : { role: s.originalRole };
    case 'team':
      return { team: s.teamAtDeath ?? s.team };
    case 'none':
      return null;
  }
}

/** Causes that trigger the Elder curse (§8.3 step 3). */
const curseCause = (c: DeathCause) => c.tag === 'execution' || ((c.tag === 'poison' || c.tag === 'hunter') && c.byTeam === 'Village');

/**
 * Death batch processing (ruleset §8.3 steps 1–5): close under heartbreak, everyone dies at
 * the same instant, the Elder curse is checked before any trigger, deaths are announced
 * together in seat order (causes are spectator-only), and the batch members' triggers are
 * appended to the FIFO queue in seat order. Returns the seats that actually died.
 */
export function killBatch(g: Game, entries: DeathEntry[]): SeatId[] {
  const merged = new Map<SeatId, DeathCause[]>();
  const add = (seat: SeatId, cause: DeathCause) => {
    if (!seatOf(g, seat).alive) return;
    const causes = merged.get(seat) ?? [];
    if (!causes.some((c) => c.tag === cause.tag && c.byTeam === cause.byTeam)) causes.push(cause);
    merged.set(seat, causes);
  };
  for (const e of entries) add(e.seat, e.cause);
  // 1. heartbreak closure
  for (let changed = true; changed; ) {
    changed = false;
    for (const n of [...merged.keys()]) {
      const partner = seatOf(g, n).loverId;
      if (partner !== null && seatOf(g, partner).alive && !merged.has(partner)) {
        add(partner, { tag: 'heartbreak' });
        changed = true;
      }
    }
  }
  const batch = [...merged.keys()].sort((a, b) => a - b);
  if (batch.length === 0) return [];
  // 2. everyone dies at the same instant
  for (const n of batch) {
    const s = seatOf(g, n);
    s.alive = false;
    s.diedOn = { phase: g.phase, n: g.phase === 'night' || g.phase === 'dawn' ? g.night : g.day };
    s.deathCauses = merged.get(n)!;
    s.teamAtDeath = s.team;
    if (s.wolfNature) g.wolfHasDied = true;
  }
  g.deathThisCycle = true;
  // 3. Elder curse (before any trigger)
  let curse = false;
  if (g.cfg.rules.elder_curse) {
    for (const n of batch) {
      const s = seatOf(g, n);
      if (s.role === 'elder' && s.teamAtDeath === 'Village' && s.deathCauses.some(curseCause)) curse = true;
    }
  }
  if (curse) for (const s of g.seats) if (s.team === 'Village' && (s.alive || batch.includes(s.seat))) s.powersActive = false;
  // 4. announcement
  emit(g, 'DEATHS', { deaths: batch.map((n) => ({ seat: n, reveal: revealOf(g, n) })) }, PUBLIC);
  emit(g, 'DEATH_CAUSES', { deaths: batch.map((n) => ({ seat: n, causes: seatOf(g, n).deathCauses.map((c) => c.tag) })) }, SPECTATOR);
  if (curse) emit(g, 'ELDER_CURSE', {}, PUBLIC);
  // 5. triggers, in seat order
  for (const n of batch) {
    const s = seatOf(g, n);
    for (const kind of SHERIFF_TITLE.deathTriggers(s)) g.triggers.push({ kind, seat: n });
    const role = behaviorOf(s.role);
    if (s.powersActive && role.deathTriggers) for (const kind of role.deathTriggers(g, s)) g.triggers.push({ kind, seat: n });
    if (g.scapegoatTieExecution === n && s.role === 'scapegoat') g.triggers.push({ kind: 'scapegoat_ruling', seat: n });
  }
  for (const w of g.seats) {
    if (w.alive && w.role === 'wild_child' && !w.convertedWolf && w.roleModel !== null && batch.includes(w.roleModel)) {
      g.triggers.push({ kind: 'wild_child_convert', seat: w.seat });
    }
  }
  // Lovers re-evaluation and Cupid reversion
  evaluateLovers(g);
  return batch;
}

/** Process the trigger queue FIFO until empty (ruleset §8.3 step 5). */
export function drainTriggers(g: Game): void {
  while (g.triggers.length > 0) {
    const t = g.triggers.shift()!;
    switch (t.kind) {
      case 'sheriff_successor':
        sheriffSuccession(g, t.seat);
        break;
      case 'hunter_shot':
        hunterShot(g, t.seat);
        break;
      case 'wild_child_convert': {
        const w = seatOf(g, t.seat);
        if (w.alive && !w.convertedWolf) {
          w.convertedWolf = true;
          changeTeam(g, w, { team: 'Werewolf', wolfNature: true }, 'wild_child');
        }
        break;
      }
      case 'scapegoat_ruling':
        scapegoatRuling(g, t.seat);
        break;
    }
  }
}

function sheriffSuccession(g: Game, dead: SeatId): void {
  const s = seatOf(g, dead);
  s.sheriff = false;
  const targets = livingSeats(g);
  if (targets.length === 0) {
    emit(g, 'SHERIFF_CHANGE', { from: dead, to: null }, PUBLIC);
    return;
  }
  const [r] = ask(g, [{ seat: dead, kind: 'target', context: 'sheriff_successor', legal: { targets, allowNone: false }, optional: false }]);
  const to = (r!.decision as DecisionOf<'target'>).target;
  const valid = to !== null && seatOf(g, to).alive;
  if (valid) seatOf(g, to).sheriff = true;
  emit(g, 'SHERIFF_CHANGE', { from: dead, to: valid ? to : null }, PUBLIC);
}

function hunterShot(g: Game, hunter: SeatId): void {
  const targets = livingSeats(g);
  if (targets.length === 0) return;
  const h = seatOf(g, hunter);
  const [r] = ask(g, [{ seat: hunter, kind: 'target', context: 'hunter_shot', legal: { targets, allowNone: false }, optional: false }]);
  const target = (r!.decision as DecisionOf<'target'>).target;
  if (target === null || !seatOf(g, target).alive) {
    // only a fallback can produce no shot: keep it spectator-only (no timeout / role leak)
    emit(g, 'HUNTER_NO_SHOT', { hunter }, SPECTATOR);
    return;
  }
  emit(g, 'HUNTER_SHOT', { hunter, target }, PUBLIC);
  killBatch(g, [{ seat: target, cause: { tag: 'hunter', byTeam: h.teamAtDeath ?? h.team } }]);
}

/** Scapegoat executed on a tie (§9.3): chooses who may vote tomorrow; everyone else is banned. */
function scapegoatRuling(g: Game, seat: SeatId): void {
  const s = seatOf(g, seat);
  if (!s.powersActive) return;
  const targets = livingSeats(g);
  if (targets.length === 0) return;
  const [r] = ask(g, [{ seat, kind: 'multi', context: 'scapegoat_ruling', legal: { targets, min: 1, max: targets.length }, optional: false }]);
  const voters = [...(r!.decision as DecisionOf<'multi'>).targets].sort((a, b) => a - b);
  for (const n of targets) seatOf(g, n).voteBannedNextDay = !voters.includes(n);
  emit(g, 'SCAPEGOAT_RULING', { voters }, PUBLIC);
}
