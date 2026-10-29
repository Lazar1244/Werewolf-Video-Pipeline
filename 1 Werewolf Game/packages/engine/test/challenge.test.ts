import { describe, expect, it } from 'vitest';
import type { DecisionRequest, EngineEvent, RoleId } from '@ww/shared';
import { simulate } from '../src/sim';
import { makeCfg, ofType, payloads, playApi, scripted } from './helpers';

/**
 * Challenges (ruleset §9.2, owner 2026-10-21): in a discussion speech a player may call out another living player,
 * who answers at once (a `challenge_answer` speech of at most words.challenge_answer). Once per player per game
 * (challenges_per_player, default 1). Unusable call-outs are ignored, never rejected. When the challenged player is the
 * very next speaker, the answer stands as their turn (challenge_answer_is_turn), and an answer may challenge on
 * (challenge_in_answer), both owner 2026-10-28.
 */

// Fixed deal: seat 1 werewolf, 2 seer, 3-5 villagers. The wolf kills seat 4 on night 1, so day 1 has 1, 2, 3, 5.
const FIVE = ['werewolf', 'seer', 'villager', 'villager', 'villager'] as const;
const KILL4 = { 'N1:wolf_kill': { target: 4 } };
const say = (text: string, extra: Record<string, unknown> = {}) => ({ speech: text, lean: null, claim: null, ...extra });

/** The public talk of a game, in order: speeches and call-outs. */
const talk = (events: EngineEvent[]) =>
  events
    .filter((e) => e.type === 'SPEECH' || e.type === 'CHALLENGE')
    .map((e) => {
      const p = e.payload as any;
      return e.type === 'CHALLENGE' ? `CHALLENGE ${p.seat}->${p.target} r${p.round}` : `${p.seat} ${p.context} r${p.round}`;
    });

describe('Challenges (ruleset §9.2)', () => {
  it('the challenged player answers right after the challenger, then the round goes on', () => {
    const seen: DecisionRequest[] = [];
    const g = simulate(
      makeCfg([...FIVE], { discussion_rounds: 1 }),
      scripted({
        ...KILL4,
        'D1:discussion:1': (req) => {
          seen.push(req);
          return say('Cora, you went very quiet. Why?', { challenge: 3 });
        },
        'D1:challenge_answer:3': (req) => {
          seen.push(req);
          return say('I was listening. Ask Bram instead.');
        },
      }),
    );
    expect(payloads(g, 'CHALLENGE')).toEqual([{ seat: 1, target: 3, round: 1 }]);
    const lines = talk(g.events.filter((e) => e.at.day === 1 && e.at.phase === 'day'));
    const i = lines.indexOf('CHALLENGE 1->3 r1');
    expect(lines[i - 1]).toBe('1 discussion r1');
    expect(lines[i + 1]).toBe('3 challenge_answer r1');
    // the answer is a 60-word speech that may carry a Challenge of its own (challenge_in_answer), even back at seat 1
    const [ask1, answer3] = seen;
    expect(ask1!.legal.challengeTargets).toEqual([2, 3, 5]);
    expect(answer3!.words).toBe(60);
    expect(answer3!.legal.challengeTargets).toEqual([1, 2, 5]);
    // the answering player still has their own discussion turn
    expect(lines.filter((l) => l === '3 discussion r1')).toHaveLength(1);
  });

  // owner (2026-10-28): day 1 speaks 1, 2, 3, 5 (seat 4 died); a challenged player who is up next does not speak twice in a row
  it('a challenged player who is the next speaker does not speak again: the answer is their turn', () => {
    const g = simulate(
      makeCfg([...FIVE], { discussion_rounds: 1 }),
      scripted({ ...KILL4, 'D1:discussion:1': say('Bram, you first. Explain.', { challenge: 2 }), 'D1:challenge_answer:2': say('Gladly.') }),
    );
    expect(talk(g.events.filter((e) => e.at.day === 1 && e.at.phase === 'day'))).toEqual([
      '1 discussion r1',
      'CHALLENGE 1->2 r1',
      '2 challenge_answer r1',
      '3 discussion r1',
      '5 discussion r1',
    ]);
  });

  it("that answer's lean counts as the turn's lean toward the pre-vote rebuttal", () => {
    const g = simulate(
      makeCfg([...FIVE], { discussion_rounds: 1 }),
      scripted({
        ...KILL4,
        'D1:discussion:1': say('Cora is odd. Bram, explain.', { lean: 3, challenge: 2 }),
        'D1:challenge_answer:2': say('Cora is the odd one.', { lean: 3 }),
      }),
    );
    // two leans at Cora (seat 1's speech and seat 2's answer, which was seat 2's turn): Cora gets a rebuttal
    expect(payloads(g, 'SPEECH').filter((p) => p.context === 'rebuttal').map((p) => p.seat)).toEqual([3]);
  });

  it('works across rounds: the last speaker challenges the first of the next round, who then skips that turn', () => {
    const g = simulate(
      makeCfg([...FIVE], { discussion_rounds: 2 }),
      scripted({ ...KILL4, 'D1:discussion:5': (req) => say('Ada, answer me.', req.round === 1 ? { challenge: 1 } : {}) }),
    );
    const lines = talk(g.events.filter((e) => e.at.day === 1 && e.at.phase === 'day'));
    expect(lines.slice(3, 7)).toEqual(['5 discussion r1', 'CHALLENGE 5->1 r1', '1 challenge_answer r1', '2 discussion r2']);
    expect(lines.filter((l) => l === '1 discussion r2')).toHaveLength(0);
  });

  it('skips over dead seats to find the next speaker (seat 4 is dead, so 5 comes right after 3)', () => {
    const g = simulate(
      makeCfg([...FIVE], { discussion_rounds: 1 }),
      scripted({ ...KILL4, 'D1:discussion:3': say('Elin, your turn to explain.', { challenge: 5 }) }),
    );
    const lines = talk(g.events.filter((e) => e.at.day === 1 && e.at.phase === 'day'));
    expect(lines).toEqual(['1 discussion r1', '2 discussion r1', '3 discussion r1', 'CHALLENGE 3->5 r1', '5 challenge_answer r1']);
  });

  it('does not skip a turn in the final round when nobody speaks after the challenger', () => {
    const g = simulate(
      makeCfg([...FIVE], { discussion_rounds: 1 }),
      scripted({ ...KILL4, 'D1:discussion:5': say('Ada, answer me.', { challenge: 1 }) }),
    );
    const lines = talk(g.events.filter((e) => e.at.day === 1 && e.at.phase === 'day'));
    expect(lines).toEqual(['1 discussion r1', '2 discussion r1', '3 discussion r1', '5 discussion r1', 'CHALLENGE 5->1 r1', '1 challenge_answer r1']);
  });

  it('games frozen before this switch keep the old order (the answer never replaces a turn)', () => {
    const old = makeCfg([...FIVE], { discussion_rounds: 1 });
    delete (old.rules as { challenge_answer_is_turn?: boolean }).challenge_answer_is_turn;
    const g = simulate(old, scripted({ ...KILL4, 'D1:discussion:1': say('Bram, explain.', { challenge: 2 }) }));
    const lines = talk(g.events.filter((e) => e.at.day === 1 && e.at.phase === 'day'));
    expect(lines.slice(0, 4)).toEqual(['1 discussion r1', 'CHALLENGE 1->2 r1', '2 challenge_answer r1', '2 discussion r1']);
  });

  it('an answer may challenge a third player, who answers at once; then the round goes on', () => {
    const g = simulate(
      makeCfg([...FIVE], { discussion_rounds: 1 }),
      scripted({ ...KILL4, 'D1:discussion:1': say('Cora, explain.', { challenge: 3 }), 'D1:challenge_answer:3': say('Ask Elin.', { challenge: 5 }) }),
    );
    expect(talk(g.events.filter((e) => e.at.day === 1 && e.at.phase === 'day'))).toEqual([
      '1 discussion r1', 'CHALLENGE 1->3 r1', '3 challenge_answer r1', 'CHALLENGE 3->5 r1', '5 challenge_answer r1',
      '2 discussion r1', '3 discussion r1', // seat 3 answered but was not up next: it keeps its turn
      // seat 5 answered after seat 3's turn, not right before its own, so it speaks too
      '5 discussion r1',
    ]);
    expect(g.seats[2]!.challengesLeft).toBe(0);
  });

  it('a duel: the answer challenges the challenger back, who answers once (no Challenge left), and it stops', () => {
    const g = simulate(
      makeCfg([...FIVE], { discussion_rounds: 1 }),
      scripted({
        ...KILL4,
        'D1:discussion:1': say('Cora, explain.', { challenge: 3 }),
        'D1:challenge_answer:3': say('No, you explain.', { challenge: 1 }),
        'D1:challenge_answer:1': (req) => {
          expect(req.legal.challengeTargets).toBeUndefined(); // seat 1 spent its Challenge
          return say('Fine.');
        },
      }),
    );
    const lines = talk(g.events.filter((e) => e.at.day === 1 && e.at.phase === 'day'));
    expect(lines.slice(0, 6)).toEqual(['1 discussion r1', 'CHALLENGE 1->3 r1', '3 challenge_answer r1', 'CHALLENGE 3->1 r1', '1 challenge_answer r1', '2 discussion r1']);
  });

  it("in a chain, only a turn that comes right after a player's own answer is skipped", () => {
    // 1 challenges 2 (up next), 2 challenges 3: seat 3 spoke after seat 2's answer, so 2 and 3 take their turns (owner:
    // "if a player speaks after them, then them again is ok")
    const g = simulate(
      makeCfg([...FIVE], { discussion_rounds: 1 }),
      scripted({
        ...KILL4,
        'D1:discussion:1': say('Bram?', { challenge: 2 }),
        'D1:challenge_answer:2': say('Cora is the wolf.', { lean: 3, challenge: 3 }),
        'D1:challenge_answer:3': say('Not me.', { lean: 2 }),
      }),
    );
    expect(talk(g.events.filter((e) => e.at.day === 1 && e.at.phase === 'day'))).toEqual([
      '1 discussion r1', 'CHALLENGE 1->2 r1', '2 challenge_answer r1', 'CHALLENGE 2->3 r1', '3 challenge_answer r1',
      '2 discussion r1', '3 discussion r1', '5 discussion r1',
    ]);
  });

  it('with 2 Challenges each, a long chain: only the last answerer, up next, is skipped', () => {
    const g0 = { answered5: 0 }; // seat 5 challenges on in its first answer only
    // round 1: 3 challenges 5, then 5 -> 1, 1 -> 2, 2 -> 3, 3 -> 5 (seat 3's second); answers 5, 1, 2, 3, 5
    const next: Record<number, number> = { 5: 1, 1: 2, 2: 3, 3: 5 };
    const g = simulate(
      makeCfg([...FIVE], { discussion_rounds: 2, challenges_per_player: 2 }),
      scripted({
        ...KILL4,
        'D1:discussion:3': (req) => say('Elin?', req.round === 1 ? { challenge: 5 } : {}),
        challenge_answer: (req) => say('No, you.', req.seat === 5 && g0.answered5++ ? {} : { challenge: next[req.seat] }),
      }),
    );
    const lines = talk(g.events.filter((e) => e.at.day === 1 && e.at.phase === 'day')).filter((l) => /discussion|challenge|CHALLENGE/.test(l));
    const i = lines.indexOf('3 discussion r1');
    expect(lines.slice(i)).toEqual([
      '3 discussion r1', 'CHALLENGE 3->5 r1', '5 challenge_answer r1', 'CHALLENGE 5->1 r1', '1 challenge_answer r1',
      'CHALLENGE 1->2 r1', '2 challenge_answer r1', 'CHALLENGE 2->3 r1', '3 challenge_answer r1', 'CHALLENGE 3->5 r1',
      '5 challenge_answer r1', // 5 is up next right after its own answer: that answer is its round-1 turn
      '1 discussion r2', '2 discussion r2', '3 discussion r2', '5 discussion r2',
    ]);
  });

  it('games frozen before challenge_in_answer offer no Challenge in an answer', () => {
    const old = makeCfg([...FIVE], { discussion_rounds: 1 });
    delete (old.rules as { challenge_in_answer?: boolean }).challenge_in_answer;
    const seen: DecisionRequest[] = [];
    simulate(
      old,
      scripted({
        ...KILL4,
        'D1:discussion:1': say('Cora, explain.', { challenge: 3 }),
        'D1:challenge_answer:3': (req) => {
          seen.push(req);
          return say('Ask Elin.', { challenge: 5 });
        },
      }),
    );
    expect(seen[0]!.legal.challengeTargets).toBeUndefined();
  });

  it('is once per player per game: later requests offer none and later tries are ignored', () => {
    const asks: DecisionRequest[] = [];
    const g = simulate(
      makeCfg([...FIVE]),
      scripted({
        ...KILL4,
        'discussion:1': (req) => {
          asks.push(req);
          return say('Again!', { challenge: 3 });
        },
      }),
    );
    expect(payloads(g, 'CHALLENGE').filter((p) => p.seat === 1)).toHaveLength(1);
    expect(asks[0]!.legal.challengeTargets).toBeDefined();
    for (const r of asks.slice(1)) expect(r.legal.challengeTargets).toBeUndefined();
  });

  it('ignores a call-out at oneself, a dead player or a missing seat, and keeps the Challenge', () => {
    const g = simulate(
      makeCfg([...FIVE]),
      scripted({
        ...KILL4,
        'D1:discussion:1': (req) => say('hm', { challenge: req.round === 1 ? 1 : 4 }), // round 1: self; round 2: dead
        'D1:discussion:2': say('?', { challenge: 9 }), // no seat 9 in a 5-player game
      }),
    );
    expect(ofType(g, 'CHALLENGE')).toHaveLength(0);
    expect(g.seats[0]!.challengesLeft).toBe(1);
    expect(g.seats[1]!.challengesLeft).toBe(1);
  });

  it('works in any discussion round', () => {
    const g = simulate(makeCfg([...FIVE]), scripted({ ...KILL4, 'D1:discussion:2': (req) => say('Now you, Elin.', req.round === 2 ? { challenge: 5 } : {}) }));
    expect(payloads(g, 'CHALLENGE')).toEqual([{ seat: 2, target: 5, round: 2 }]);
  });

  it("the answer's lean does not count toward the pre-vote rebuttal", () => {
    const g = simulate(
      makeCfg([...FIVE], { discussion_rounds: 1 }),
      scripted({
        ...KILL4,
        'D1:discussion:1': say('Bram looks odd. Cora, explain yourself.', { lean: 2, challenge: 3 }),
        'D1:challenge_answer:3': say('Bram is the odd one.', { lean: 2 }),
      }),
    );
    // only one discussion lean at Bram (seat 2): no rebuttal; counting the answer would have made it two
    expect(payloads(g, 'SPEECH').filter((p) => p.context === 'rebuttal')).toHaveLength(0);
  });

  it('is off for games frozen before Challenges existed, and with challenges_per_player 0', () => {
    const old = makeCfg([...FIVE]);
    delete (old.rules as { challenges_per_player?: number }).challenges_per_player;
    delete (old.rules.words as { challenge_answer?: number }).challenge_answer;
    const none = makeCfg([...FIVE], { challenges_per_player: 0 });
    for (const cfg of [old, none]) {
      const asks: DecisionRequest[] = [];
      const g = simulate(
        cfg,
        scripted({
          ...KILL4,
          discussion: (req) => {
            asks.push(req);
            return say('x', { challenge: req.seat === 3 ? 2 : 3 });
          },
        }),
      );
      expect(ofType(g, 'CHALLENGE')).toHaveLength(0);
      expect(asks.length).toBeGreaterThan(0);
      for (const r of asks) expect(r.legal.challengeTargets).toBeUndefined();
    }
  });

  it('replays exactly: the API path gives the same events as a direct simulation', () => {
    const plan = { ...KILL4, 'D1:discussion:1': say('You. Explain.', { challenge: 5 }), 'D1:challenge_answer:5': say('Fine: I trust Bram.') };
    const cfg = makeCfg([...FIVE]);
    const direct = simulate(cfg, scripted(plan));
    const api = playApi(cfg, scripted(plan));
    expect(api.events.map((e) => [e.type, e.payload])).toEqual(direct.events.map((e) => [e.type, e.payload]));
    expect(talk(api.events)).toContain('CHALLENGE 1->5 r1');
  });

  it('survives a Thief swap (kept apart from the role uses that a swap resets)', () => {
    const deck: RoleId[] = ['thief', 'werewolf', 'seer', 'villager', 'villager', 'villager', 'villager', 'witch', 'werewolf'];
    const g = simulate(
      makeCfg(deck),
      scripted({ 'N1:thief': { choice: 'extra1' }, 'N1:wolf_kill': { target: 3 }, 'N1:witch': { heal: true, poison: null }, 'D1:discussion:1': say('Elin, a word.', { challenge: 5 }) }),
    );
    expect(payloads(g, 'ROLE_CHANGED')[0]).toMatchObject({ seat: 1, role: 'witch', reason: 'thief' });
    expect(payloads(g, 'CHALLENGE')).toContainEqual({ seat: 1, target: 5, round: 1 });
    expect(g.seats[0]!.challengesLeft).toBe(0);
  });

  it('is never offered outside discussion speeches (Sheriff election, rebuttal, Judge round, last words)', () => {
    const lock = (t: number) => ({ message: 'go', proposed_target: t, ready: true });
    const cards: RoleId[] = ['werewolf', 'werewolf', 'stuttering_judge', 'seer', 'witch', 'villager', 'villager'];
    const speeches: DecisionRequest[] = [];
    const plan = scripted({ 'N1:council': lock(7), 'D1:sheriff_run:5': { run: true }, 'D1:day:3': { vote: 'abstain', second_vote: true } });
    simulate(makeCfg(cards), (req, g) => {
      if (req.kind === 'speech') speeches.push(req);
      return plan(req, g);
    });
    const contexts = new Set(speeches.map((r) => r.context));
    expect(contexts).toContain('sheriff');
    expect(contexts).toContain('judge_round');
    for (const r of speeches) if (r.context !== 'discussion') expect(r.legal.challengeTargets, r.context).toBeUndefined();
  });
});
