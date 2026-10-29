import type { DecisionOf, SeatId, SpeechContext, VoteContext } from '@ww/shared';
import { pick } from '../rng';
import { PUBLIC, ask, emit, living, livingSeats, seatOf, speakingOrder } from './core';
import { drainTriggers, killBatch } from './deaths';
import { SHERIFF_TITLE } from './roles';
import { changeTeam } from './teams';
import type { Game } from './types';
import { checkWin, finish } from './win';

function wordsFor(g: Game, ctx: SpeechContext): number {
  const w = g.cfg.rules.words;
  switch (ctx) {
    case 'discussion':
      return w.speech;
    case 'sheriff':
      return w.sheriff_speech;
    case 'rebuttal':
      return w.rebuttal;
    case 'defence':
      return w.defence;
    case 'last_words':
      return w.last_words;
    case 'judge_round':
      return w.judge_round_speech;
    case 'debrief_comment':
      return w.debrief_comment;
    case 'debrief_reply':
      return w.debrief_reply;
    case 'challenge_answer':
      return w.challenge_answer ?? 60;
  }
}

/**
 * One speech turn. The inner monologue (SEAT_THOUGHTS) is emitted by ask() right before
 * the SPEECH event, so every speech reads as "what they thought" then "what they said".
 * A discussion speech may carry a Challenge while the speaker has one left (ruleset §9.2), and so may a Challenge
 * answer with `challenge_in_answer`; the returned `challenge` is the usable one or null (anything else is ignored,
 * never rejected).
 */
export function speak(g: Game, seat: SeatId, ctx: SpeechContext, round: number | null): DecisionOf<'speech'> {
  const leanTargets = livingSeats(g).filter((n) => n !== seat);
  const mayChallenge = ctx === 'discussion' || (ctx === 'challenge_answer' && (g.cfg.rules.challenge_in_answer ?? false));
  const challengeTargets = mayChallenge && seatOf(g, seat).challengesLeft > 0 ? leanTargets : [];
  const rounds = ctx === 'discussion' && round !== null ? { round, maxRounds: g.cfg.rules.discussion_rounds } : {};
  const legal = challengeTargets.length ? { leanTargets, challengeTargets } : { leanTargets };
  const [r] = ask(g, [{ seat, kind: 'speech', context: ctx, legal, words: wordsFor(g, ctx), optional: false, ...rounds }]);
  const d = r!.decision as DecisionOf<'speech'>;
  const lean = d.lean != null && leanTargets.includes(d.lean) ? d.lean : null;
  const challenge = d.challenge != null && challengeTargets.includes(d.challenge) ? d.challenge : null;
  emit(g, 'SPEECH', { seat, context: ctx, round, text: d.speech, lean, claim: d.claim ?? null }, PUBLIC);
  return { ...d, lean, challenge };
}

/**
 * A Challenge (ruleset §9.2): the challenger spends it, the call-out is announced, and the challenged player
 * answers at once (a `challenge_answer` speech whose lean does not count toward the pre-vote rebuttal, unless the
 * answer stands as the player's turn: see day()). With `challenge_in_answer` the answer may carry a Challenge of
 * its own, even back at the challenger, and so on; each one spends a Challenge, so the chain always ends.
 * Returns the chain's last answer: the speech heard just before the next turn.
 */
function challenge(g: Game, seat: SeatId, target: SeatId, round: number): { seat: SeatId; lean: SeatId | null } {
  for (let by = seat, at = target; ; ) {
    seatOf(g, by).challengesLeft -= 1;
    emit(g, 'CHALLENGE', { seat: by, target: at, round }, PUBLIC);
    const a = speak(g, at, 'challenge_answer', round);
    if (a.challenge == null) return { seat: at, lean: a.lean ?? null };
    [by, at] = [at, a.challenge];
  }
}

/** Day k (ruleset §9). Returns true when the game is over. */
export function day(g: Game): boolean {
  g.phase = 'day';
  emit(g, 'PHASE_START', { phase: 'day', day: g.day }, PUBLIC);
  if (g.day === 1 && g.cfg.rules.sheriff_enabled) sheriffElection(g);

  // Discussion rounds (§9.2)
  const order = speakingOrder(g);
  let finalLeans: (SeatId | null)[] = [];
  // owner (2026-10-28): nobody speaks twice in a row. A player whose turn comes right after their own Challenge
  // answer (nobody spoke in between) has just spoken: the answer stands as that turn and its lean counts for it.
  // If anyone spoke in between, they take their turn as usual.
  const answerIsTurn = g.cfg.rules.challenge_answer_is_turn ?? false;
  let justAnswered: { seat: SeatId; lean: SeatId | null } | null = null; // the last speech, when it was an answer
  for (let round = 1; round <= g.cfg.rules.discussion_rounds; round++) {
    finalLeans = [];
    for (const seat of order) {
      if (!seatOf(g, seat).alive) continue;
      if (answerIsTurn && justAnswered?.seat === seat) {
        finalLeans.push(justAnswered.lean);
        continue;
      }
      justAnswered = null;
      const s = speak(g, seat, 'discussion', round);
      finalLeans.push(s.lean ?? null);
      if (s.challenge != null) justAnswered = challenge(g, seat, s.challenge, round);
    }
  }

  // Pre-vote rebuttal: most-leaned-at players (>= 2 leans, at most 2 players)
  const counts = new Map<SeatId, number>();
  for (const l of finalLeans) if (l !== null) counts.set(l, (counts.get(l) ?? 0) + 1);
  if (counts.size > 0) {
    const max = Math.max(...counts.values());
    const top = [...counts.entries()].filter(([, c]) => c === max).map(([s]) => s);
    if (max >= 2 && top.length <= 2) {
      for (const seat of order) if (top.includes(seat) && seatOf(g, seat).alive) speak(g, seat, 'rebuttal', null);
    }
  }

  if (voteAndExecute(g, 'day', 'runoff', true)) return true;

  // Stuttering Judge: a second vote if the flag was validly set on today's first ballot (§9.3)
  const judge = g.seats.find((s) => s.judgeFlagToday);
  if (judge) {
    judge.uses.judge = 0;
    emit(g, 'SECOND_VOTE', {}, PUBLIC);
    for (const seat of speakingOrder(g)) if (seatOf(g, seat).alive) speak(g, seat, 'judge_round', 1);
    if (voteAndExecute(g, 'second_vote', 'second_runoff', false)) return true;
  }
  return false;
}

interface TallyResult {
  outcome: 'execute' | 'none' | 'tie';
  target: SeatId | null;
  top: SeatId[];
}

/** Sealed ballot + tally formula (ruleset §9.3). */
function ballot(g: Game, context: VoteContext, candidates: SeatId[], ravenApplies: boolean): TallyResult {
  const voters = living(g).filter((s) => s.canVote && !s.voteBannedToday);
  const judgeMayFlag = (s: (typeof voters)[number]) =>
    context === 'day' && s.role === 'stuttering_judge' && s.powersActive && (s.uses.judge ?? 0) > 0;
  const res = ask(
    g,
    voters.map((v) => ({
      seat: v.seat,
      kind: 'vote' as const,
      context,
      legal: { targets: candidates.filter((c) => c !== v.seat), allowNone: true, ...(judgeMayFlag(v) ? { secondVote: true } : {}) },
      optional: false,
    })),
  );
  const ballots = voters.map((v, i) => {
    const d = res[i]!.decision as DecisionOf<'vote'>;
    if (d.second_vote && judgeMayFlag(v)) v.judgeFlagToday = true; // secret: never published
    return { voter: v.seat, vote: d.vote, weight: SHERIFF_TITLE.voteWeight(v) };
  });
  const score = new Map<SeatId, number>();
  let abstain = 0;
  for (const b of ballots) {
    if (b.vote === 'abstain') abstain += b.weight;
    else score.set(b.vote, (score.get(b.vote) ?? 0) + b.weight);
  }
  // Raven: +2 for the marked player, only if it has at least one real vote (first vote and its runoff)
  const raven = ravenApplies && g.ravenMark !== null && seatOf(g, g.ravenMark).alive ? g.ravenMark : null;
  if (raven !== null && score.has(raven)) score.set(raven, score.get(raven)! + 2);
  const T = score.size ? Math.max(...score.values()) : 0;
  const top = [...score.entries()].filter(([, s]) => s === T && T > 0).map(([c]) => c).sort((a, b) => a - b);
  emit(g, 'VOTES', { context, ballots, scores: Object.fromEntries(score), abstain, raven }, PUBLIC);
  if (T === 0 || (g.cfg.rules.abstain_blocks_execution && T <= abstain)) return { outcome: 'none', target: null, top };
  if (top.length === 1) return { outcome: 'execute', target: top[0]!, top };
  return { outcome: 'tie', target: null, top };
}

/** Vote, runoff and execution sequence (§9.3). Returns true when the game is over. */
function voteAndExecute(g: Game, first: VoteContext, runoff: VoteContext, ravenApplies: boolean): boolean {
  let t = ballot(g, first, livingSeats(g), ravenApplies);
  let scapegoat = false;
  if (t.outcome === 'tie') {
    emit(g, 'RUNOFF', { candidates: t.top }, PUBLIC);
    for (const seat of speakingOrder(g)) if (t.top.includes(seat)) speak(g, seat, 'defence', null);
    t = ballot(g, runoff, t.top, ravenApplies);
    if (t.outcome === 'tie') {
      const sg = g.seats.find((s) => s.alive && s.role === 'scapegoat' && s.powersActive);
      if (sg) {
        t = { outcome: 'execute', target: sg.seat, top: t.top };
        scapegoat = true;
      }
    }
  }
  if (t.outcome !== 'execute' || t.target === null) {
    emit(g, 'NO_EXECUTION', { reason: t.outcome === 'tie' ? 'tie' : 'not enough votes' }, PUBLIC);
    return false;
  }
  const x = seatOf(g, t.target);
  // 1. Village Idiot: revealed, survives, loses the vote for good
  if (x.role === 'village_idiot' && x.powersActive && (x.uses.idiot_immunity ?? 0) > 0) {
    x.uses.idiot_immunity = 0;
    x.canVote = false;
    emit(g, 'IDIOT_REVEALED', { seat: x.seat }, PUBLIC);
    return checkWin(g);
  }
  // 2. last words, 3. death processing (+ Scapegoat ruling), 4. win check
  emit(g, 'EXECUTION', scapegoat ? { seat: x.seat, scapegoat: true } : { seat: x.seat }, PUBLIC);
  speak(g, x.seat, 'last_words', null);
  g.scapegoatTieExecution = scapegoat ? x.seat : null;
  killBatch(g, [{ seat: x.seat, cause: { tag: 'execution' } }]);
  drainTriggers(g);
  g.scapegoatTieExecution = null;
  return checkWin(g);
}

/** Sheriff election on Day 1 (ruleset §9.1). */
function sheriffElection(g: Game): void {
  const order = speakingOrder(g);
  const candidates: SeatId[] = [];
  for (const seat of order) {
    const [r] = ask(g, [{ seat, kind: 'sheriff_run', context: 'sheriff_run', legal: {}, optional: true }]);
    const run = (r!.decision as DecisionOf<'sheriff_run'>).run;
    emit(g, 'SHERIFF_CANDIDACY', { seat, run }, PUBLIC);
    if (run) candidates.push(seat);
  }
  if (candidates.length === 0) {
    emit(g, 'SHERIFF_RESULT', { sheriff: null, reason: 'no candidates' }, PUBLIC);
    return;
  }
  for (const c of candidates) speak(g, c, 'sheriff', null);
  let elected: SeatId | null = null;
  let reason = 'elected';
  if (candidates.length === 1) {
    elected = candidates[0]!;
    reason = 'sole candidate';
  } else {
    let pool = candidates;
    for (let attempt = 0; attempt < 2 && elected === null; attempt++) {
      const context = attempt === 0 ? 'sheriff' : 'sheriff_runoff';
      const voters = living(g).filter((s) => s.canVote);
      const res = ask(g, voters.map((v) => ({ seat: v.seat, kind: 'vote' as const, context, legal: { targets: pool, allowNone: true }, optional: false })));
      const ballots = voters.map((v, i) => ({ voter: v.seat, vote: (res[i]!.decision as DecisionOf<'vote'>).vote }));
      const score = new Map<SeatId, number>();
      let abstain = 0;
      for (const b of ballots) {
        if (b.vote === 'abstain') abstain++;
        else score.set(b.vote, (score.get(b.vote) ?? 0) + 1);
      }
      emit(g, 'VOTES', { context, ballots: ballots.map((b) => ({ ...b, weight: 1 })), scores: Object.fromEntries(score), abstain }, PUBLIC);
      const T = score.size ? Math.max(...score.values()) : 0;
      if (T === 0) {
        reason = 'no votes';
        break;
      }
      const top = [...score.entries()].filter(([, s]) => s === T).map(([c]) => c).sort((a, b) => a - b);
      if (top.length === 1) elected = top[0]!;
      else if (attempt === 1) {
        elected = pick(g.rng, top);
        reason = 'coin flip';
      } else pool = top;
    }
  }
  if (elected !== null) seatOf(g, elected).sheriff = true;
  emit(g, 'SHERIFF_RESULT', { sheriff: elected, reason }, PUBLIC);
}

/** Dusk k (ruleset §9.4). Returns true when the game is over. */
export function dusk(g: Game): boolean {
  g.phase = 'dusk';
  emit(g, 'PHASE_START', { phase: 'dusk', day: g.day }, PUBLIC);
  // 1. Angel conversion on Dusk 1
  if (g.day === 1) for (const s of g.seats) if (s.alive && s.role === 'angel' && s.team === 'Angel') changeTeam(g, s, { team: 'Village' }, 'angel');
  // 2. clears
  for (const s of g.seats) {
    s.voteBannedToday = false;
    s.judgeFlagToday = false;
  }
  g.ravenMark = null;
  // 3. stall counter
  g.cyclesWithoutDeath = g.deathThisCycle ? 0 : g.cyclesWithoutDeath + 1;
  g.deathThisCycle = false;
  // 4. win check
  if (checkWin(g)) return true;
  // 5. summary
  const cycleEvents = g.events.filter((e) => (e.at.night === g.day && e.at.phase === 'dawn') || e.at.day === g.day);
  emit(
    g,
    'DAY_SUMMARY',
    {
      day: g.day,
      deaths: cycleEvents.filter((e) => e.type === 'DEATHS').flatMap((e) => (e.payload as { deaths: unknown[] }).deaths),
      votes: cycleEvents.filter((e) => e.type === 'VOTES').map((e) => e.payload),
      alive: livingSeats(g),
      sheriff: g.seats.find((s) => s.alive && s.sheriff)?.seat ?? null,
    },
    PUBLIC,
  );
  // 6. termination
  if (g.day >= g.cfg.rules.max_days) {
    finish(g, { winner: 'draw', reason: 'day cap reached' });
    return true;
  }
  if (g.cyclesWithoutDeath >= g.cfg.rules.stall_cycles) {
    finish(g, { winner: 'draw', reason: 'stall: no deaths' });
    return true;
  }
  return false;
}
