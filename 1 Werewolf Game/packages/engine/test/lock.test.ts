import { describe, expect, it } from 'vitest';
import type { DecisionRequest, EngineEvent } from '@ww/shared';
import { advance, answer, createGame, lockOpen, type EngineState } from '../src/api';
import { makeCfg } from './helpers';

/**
 * The spectator lock (ruleset §9, §15), step by step. Regression for the owner's 2026-09-24 game:
 * the only human was killed on Night 1 and then saw every card and thought. That is the rule
 * working (`dead_human_spectates`): these tests pin down that it opens at exactly that moment —
 * when the last human is out (dead, with no dying action such as a Hunter's shot still to take) —
 * and never a step earlier.
 */
const CLASSIC_10 = ['werewolf', 'werewolf', 'werewolf', 'seer', 'witch', 'hunter', 'protector', 'little_girl', 'villager', 'villager'] as const;

/** A plain answer for every request; the pack kills `victim` whenever it can. */
function answerFor(r: DecisionRequest, victim: number): unknown {
  const legal = r.legal as { targets?: number[]; choices?: string[]; allowNone?: boolean };
  if (r.context === 'wolf_kill' || r.kind === 'council_ballot') return { target: legal.targets?.includes(victim) ? victim : legal.targets![0]! };
  if (r.kind === 'council_turn') return { message: 'agreed', proposed_target: legal.targets?.includes(victim) ? victim : legal.targets![0]!, ready: true };
  if (r.kind === 'vote') return { vote: 'abstain' };
  if (r.kind === 'speech') return { speech: 'hm', lean: null, claim: null };
  if (r.kind === 'sheriff_run') return { run: false };
  if (r.kind === 'witch') return { heal: false, poison: null };
  if (r.kind === 'choice') return { choice: legal.choices![0]! };
  if (r.kind === 'message') return { message: '' };
  if (r.kind === 'pair') return { targets: legal.targets!.slice(0, 2) };
  if (r.kind === 'multi') return { targets: legal.targets!.slice(0, 1) };
  return { target: legal.allowNone ? null : legal.targets![0]! };
}

/** Play a game with one human, recording the lock after every step and the events it produced. */
function playWithOneHuman(victimIsHuman: boolean, rules = {}) {
  const cfg = makeCfg([...CLASSIC_10], rules, { humanSlots: [1], fixedDeal: false, seed: 'lock-regression' });
  let step = advance(createGame(cfg));
  const seating = step.events.find((e) => e.type === 'SEATING')!.payload as { seats: { seat: number; slot: number; human: boolean }[] };
  const human = seating.seats.find((s) => s.human)!.seat;
  const roles = new Map(step.events.filter((e) => e.type === 'ROLE_ASSIGNED').map((e) => [(e.payload as { seat: number }).seat, (e.payload as { role: string }).role]));
  // the pack's victim: the human, or a villager that is not the human
  const victim = victimIsHuman ? human : [...roles].find(([seat, role]) => seat !== human && role === 'villager')![0];
  const timeline: { events: EngineEvent[]; open: boolean; state: EngineState }[] = [{ events: step.events, open: lockOpen(step.state), state: step.state }];
  let guard = 0;
  while (step.status === 'awaiting' && guard++ < 2000) {
    for (const r of step.open) {
      step = answer(step.state, r.requestId, { kind: 'decision', decision: answerFor(r, victim) as never });
      timeline.push({ events: step.events, open: lockOpen(step.state), state: step.state });
    }
  }
  return { human, timeline, humanRoleIsWolf: roles.get(human) === 'werewolf' };
}

const humanDiedIn = (events: EngineEvent[], human: number) => events.some((e) => e.type === 'DEATHS' && (e.payload as { deaths: { seat: number }[] }).deaths.some((d) => d.seat === human));

describe('the spectator lock, step by step (regression 2026-09-24)', () => {
  it('stays closed through the night, and opens only once the last human is dead and has no action left', () => {
    // in this deal the human is the Hunter: killed at Dawn 1, with a last shot still to take
    const { human, timeline, humanRoleIsWolf } = playWithOneHuman(true);
    expect(humanRoleIsWolf, 'the dealt human must be killable by the pack for this test').toBe(false);
    const deathStep = timeline.findIndex((t) => humanDiedIn(t.events, human));
    expect(deathStep).toBeGreaterThan(0);
    // before the death: closed at every step
    for (let i = 0; i < deathStep; i++) expect(timeline[i]!.open, `step ${i} (before the human's death)`).toBe(false);
    // at every step, open exactly when no human is alive and none has a dying action pending
    for (const [i, t] of timeline.entries()) {
      const out = t.state.humansAlive.length === 0 && t.state.humansPending.length === 0;
      expect(t.open, `step ${i}`).toBe(out || !!t.state.result);
    }
    // the dying Hunter keeps it closed until the shot; then it opens and stays open
    const firstOpen = timeline.findIndex((t) => t.open);
    expect(firstOpen).toBeGreaterThanOrEqual(deathStep);
    expect(timeline[deathStep]!.state.humansPending).toEqual([human]);
    expect(timeline[deathStep]!.open).toBe(false);
    for (let i = firstOpen; i < timeline.length; i++) expect(timeline[i]!.open, `step ${i} (after it opened)`).toBe(true);
  });

  it('while the human lives, the lock never opens — even deep into the game', () => {
    const { human, timeline } = playWithOneHuman(false);
    for (const t of timeline) {
      const dead = t.state.humansAlive.length === 0;
      if (!dead && !t.state.result) expect(t.open, 'a living human must keep the game hidden').toBe(false);
    }
    void human;
  });

  it('with dead_human_spectates off, a dead human sees nothing more until the game is over', () => {
    const { human, timeline } = playWithOneHuman(true, { dead_human_spectates: false });
    const deathStep = timeline.findIndex((t) => humanDiedIn(t.events, human));
    for (let i = deathStep; i < timeline.length; i++) {
      if (!timeline[i]!.state.result) expect(timeline[i]!.open, `step ${i}: dead, but the rule says keep it hidden`).toBe(false);
    }
    expect(timeline.at(-1)!.open).toBe(true); // it opens at the end
  });
});
