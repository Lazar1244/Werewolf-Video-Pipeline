import { describe, expect, it } from 'vitest';
import { ROLES, checkEngineEvent, validateComposition, type RoleId } from '@ww/shared';
import { advance, answer, createGame } from '../src/api';
import { createRng, nextInt, pick, shuffle, type RngState } from '../src/rng';
import { randomBot, simulate } from '../src/sim';
import { makeCfg } from './helpers';

const WOLVES: RoleId[] = ['werewolf', 'big_bad_wolf', 'accursed_wolf_father', 'white_werewolf'];
const SPECIALS: RoleId[] = [
  'seer', 'witch', 'hunter', 'protector', 'cupid', 'little_girl', 'elder', 'village_idiot', 'scapegoat', 'fox', 'knight',
  'raven', 'stuttering_judge', 'bear_tamer', 'thief', 'wild_child', 'wolf_hound', 'piper', 'angel', 'two_sisters',
];

/** A random composition that passes ruleset §12.1 (drawn from the whole catalogue). */
function randomComposition(rng: RngState): RoleId[] {
  for (;;) {
    const n = 5 + nextInt(rng, 6);
    const lo = Math.max(1, Math.floor(n / 5));
    const hi = Math.ceil(n / 3);
    const wolves = lo + nextInt(rng, hi - lo + 1);
    const cards: RoleId[] = [];
    for (let i = 0; i < wolves; i++) {
      const w = pick(rng, WOLVES);
      cards.push(w !== 'werewolf' && cards.includes(w) ? 'werewolf' : w);
    }
    for (const r of shuffle(rng, SPECIALS)) {
      if (cards.length >= n) break;
      if (nextInt(rng, 3) === 0) continue;
      if (r === 'two_sisters') {
        if (cards.length + 2 <= n) cards.push(r, r);
      } else cards.push(r);
    }
    while (cards.length < n) cards.push('villager');
    if (cards.includes('thief')) cards.push(pick(rng, ['villager', 'werewolf', 'seer', 'hunter'] as RoleId[]), 'villager');
    const seats = cards.includes('thief') ? cards.length - 2 : cards.length;
    if (validateComposition({ seats, cards }).ok) return cards;
  }
}

const DYING = new Set(['hunter_shot', 'sheriff_successor', 'scapegoat_ruling']);
const HIDDEN = new Set([
  'ROLE_ASSIGNED', 'ROLE_CHANGED', 'SEATING', 'THIEF_OFFER', 'PACK_JOINED', 'LOVER_INFO', 'SISTER_INFO', 'CHANNEL_MSG',
  'NIGHT_STEP_START', 'NIGHT_ACTION', 'SEER_RESULT', 'FOX_RESULT', 'PACK_INFO', 'PACK_LEADER', 'COUNCIL_MSG', 'COUNCIL_BALLOTS',
  'COUNCIL_RESULT', 'COUNCIL_SKIPPED', 'LITTLE_GIRL_CAUGHT', 'LITTLE_GIRL_TRANSCRIPT', 'WITCH_INFO', 'CHARMED_LIST', 'INFECTED',
  'DEATH_CAUSES', 'HUNTER_NO_SHOT', 'SEAT_THOUGHTS', 'FALLBACK_USED', 'REQUEST_OPENED', 'REQUEST_CLOSED',
]);

describe('fuzz: 10,000 random games over the whole role catalogue', () => {
  it('every game terminates legally, every event matches its schema, and hidden info stays hidden', () => {
    const rng = createRng('fuzz-compositions');
    const GAMES = 10_000;
    const winners: Record<string, number> = {};
    const rolesSeen = new Set<string>();
    let challenges = 0;
    for (let i = 0; i < GAMES; i++) {
      const cards = randomComposition(rng);
      cards.forEach((c) => rolesSeen.add(c));
      const cfg = makeCfg(
        cards,
        { little_girl_catch: 0.5, wolves_may_skip: i % 7 === 0, angel_ends_game: i % 5 !== 0, challenges_per_player: 1 + (i % 3) },
        { fixedDeal: false, seed: `fz-${i}` },
      );
      const g = simulate(cfg, randomBot(`fb${i}`, { noAnswerRate: 0.04, invalidRate: 0.03, challengeRate: 0.3 }));
      const tag = `game ${i} [${cards.join(',')}]`;

      expect(g.result, tag).not.toBeNull();
      expect(g.day, tag).toBeLessThanOrEqual(cfg.rules.max_days);
      winners[g.result!.winner] = (winners[g.result!.winner] ?? 0) + 1;

      const alive = new Set(g.seats.map((s) => s.seat));
      g.events.forEach((e, k) => {
        expect(e.eseq, tag).toBe(k + 1);
        const issues = checkEngineEvent(e);
        if (issues.length) throw new Error(`${tag}: ${issues.join('; ')}`);
        if (HIDDEN.has(e.type) && e.vis.kind === 'public') throw new Error(`${tag}: ${e.type} is public`);
        const p = e.payload as any;
        if (e.type === 'DEATHS') for (const d of p.deaths) alive.delete(d.seat);
        if (e.type === 'REQUEST_OPENED' && p.seat !== 0 && !DYING.has(p.context) && !alive.has(p.seat)) {
          throw new Error(`${tag}: request to dead seat ${p.seat} (${p.context})`);
        }
        if (e.type === 'SPEECH') {
          const closed = g.events[k - 1]!;
          const before = g.events[k - 2]!;
          if (closed.type !== 'REQUEST_CLOSED' || !['SEAT_THOUGHTS', 'FALLBACK_USED'].includes(before.type)) throw new Error(`${tag}: monologue order`);
        }
      });

      // Challenges (ruleset §9.2): within the per-game allowance, at a living other player, answered at once by them
      const used = new Map<number, number>();
      const speeches = g.events.filter((e) => e.type === 'SPEECH' || e.type === 'CHALLENGE');
      speeches.forEach((e, k) => {
        if (e.type !== 'CHALLENGE') return;
        const c = e.payload as any;
        used.set(c.seat, (used.get(c.seat) ?? 0) + 1);
        if (used.get(c.seat)! > (cfg.rules.challenges_per_player ?? 0)) throw new Error(`${tag}: seat ${c.seat} challenged too often`);
        if (c.seat === c.target) throw new Error(`${tag}: seat ${c.seat} challenged itself`);
        const prev = speeches[k - 1]?.payload as any;
        const next = speeches[k + 1]?.payload as any;
        const from = cfg.rules.challenge_in_answer ? ['discussion', 'challenge_answer'] : ['discussion'];
        if (prev?.seat !== c.seat || !from.includes(prev?.context)) throw new Error(`${tag}: a challenge must follow the challenger's own speech`);
        if (next?.seat !== c.target || next?.context !== 'challenge_answer') throw new Error(`${tag}: the challenged seat must answer at once`);
      });
      // owner (2026-10-28): with challenge_answer_is_turn, nobody speaks twice in a row (an answer, then their own
      // discussion turn), within a day (the target may open the next day)
      const said = g.events.filter((e) => e.type === 'SPEECH');
      said.forEach((e, k) => {
        const p = e.payload as any;
        const q = said[k + 1]?.payload as any;
        if (cfg.rules.challenge_answer_is_turn && p.context === 'challenge_answer' && q?.context === 'discussion' && q.seat === p.seat && said[k + 1]!.at.day === e.at.day)
          throw new Error(`${tag}: seat ${p.seat} spoke twice in a row`);
      });
      // ...and nobody loses a turn wrongly: a seat without a discussion turn in a round gave the speech heard just before
      // where that turn fell (its own answer, the last of its chain), in that round or at the end of the one before
      for (const day of new Set(said.map((e) => e.at.day))) {
        const talk = said.filter((e) => e.at.day === day && ['discussion', 'challenge_answer'].includes((e.payload as any).context));
        const voters = g.events
          .filter((e) => e.type === 'VOTES' && e.at.day === day && e.at.phase === 'day')
          .flatMap((e) => (e.payload as any).ballots.map((b: any) => b.voter));
        const seatsToday = new Set([...talk.map((e) => (e.payload as any).seat), ...voters]);
        for (let r = 1; r <= cfg.rules.discussion_rounds; r++) {
          const spoke = new Set(talk.filter((e) => (e.payload as any).context === 'discussion' && (e.payload as any).round === r).map((e) => (e.payload as any).seat));
          if (!spoke.size) continue; // the game ended before this round
          for (const seat of seatsToday) {
            if (spoke.has(seat)) continue;
            const answered = talk.some((e, j) => {
              const p = e.payload as any;
              const after = talk[j + 1]?.payload as any; // the speech after its answer is not another answer: nobody spoke in between
              return p.context === 'challenge_answer' && p.seat === seat && [r, r - 1].includes(p.round) && after?.context !== 'challenge_answer';
            });
            if (!cfg.rules.challenge_answer_is_turn || !answered) throw new Error(`${tag}: seat ${seat} lost its turn in day ${day} round ${r}`);
          }
        }
      }
      const turns = new Set<string>();
      for (const e of speeches) {
        const p = e.payload as any;
        if (e.type !== 'SPEECH' || p.context !== 'discussion') continue;
        const t = `${e.at.day}:${p.round}:${p.seat}`;
        if (turns.has(t)) throw new Error(`${tag}: seat ${p.seat} had two discussion turns in day ${e.at.day} round ${p.round}`);
        turns.add(t);
      }
      challenges += used.size ? [...used.values()].reduce((a, b) => a + b, 0) : 0;

      // the result is consistent with who is left
      const living = g.seats.filter((s) => s.alive);
      const r = g.result!;
      switch (r.winner) {
        case 'Village':
          expect(living.every((s) => s.team === 'Village'), tag).toBe(true);
          break;
        case 'Werewolf':
          expect(living.some((s) => s.team === 'Werewolf'), tag).toBe(true);
          break;
        case 'Lovers':
          expect(living.every((s) => s.team === 'Lovers'), tag).toBe(true);
          break;
        case 'WhiteWolf':
          expect(living.map((s) => s.role), tag).toEqual(['white_werewolf']);
          break;
        case 'Piper':
          expect(living.every((s) => s.role === 'piper' || s.charmed), tag).toBe(true);
          break;
        case 'Angel':
          expect(g.seats.find((s) => s.role === 'angel')!.alive, tag).toBe(false);
          break;
        case 'draw':
          expect(r.winners.every((n) => g.seats[n - 1]!.role === 'angel'), tag).toBe(true);
          break;
      }
    }
    // coverage: every role was dealt, and many kinds of results happened
    for (const role of Object.keys(ROLES)) expect(rolesSeen.has(role), role).toBe(true);
    for (const w of ['Village', 'Werewolf', 'Lovers', 'Piper', 'Angel']) expect(winners[w] ?? 0, w).toBeGreaterThan(0);
    expect(challenges, 'Challenges were exercised').toBeGreaterThan(1_000);
  }, 600_000);

  it('replay equals direct simulation for full-catalogue games (answers in reverse order, JSON round-trips)', () => {
    const rng = createRng('fuzz-replay');
    for (let i = 0; i < 40; i++) {
      const cards = randomComposition(rng);
      const cfg = makeCfg(cards, { little_girl_catch: 0.5 }, { fixedDeal: false, seed: `rp-${i}` });
      const bot = randomBot(`rb${i}`, { noAnswerRate: 0.05 });
      let step = advance(createGame(cfg));
      const events = [...step.events];
      while (step.status === 'awaiting') {
        for (const r of [...step.open].reverse()) {
          step = answer(JSON.parse(JSON.stringify(step.state)), r.requestId, bot(r, undefined as never));
          events.push(...step.events);
        }
      }
      const recorded = step.state.answers;
      expect(events).toEqual(simulate(cfg, (req) => recorded[req.requestId]!).events);
    }
  }, 300_000);
});
