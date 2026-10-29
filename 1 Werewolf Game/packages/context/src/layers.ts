import { ENGINE_CLOSE, ENGINE_OPEN, truncateWords } from '@ww/engine';
import { describe, roleLabel, type GameView, type NameOf, type ViewEntry } from '@ww/projector';
import type { DecisionRequest, EnginePayload, ResolvedRules } from '@ww/shared';
import { estimateTokens } from './budget';
import { packFile, render, type PromptPack } from './pack';
import { roleVars } from './system';

/** L1, the role card (ruleset §14.2): includes the seat's display name. */
export function roleCard(pack: PromptPack, view: GameView, rules: ResolvedRules, name: NameOf): string {
  const me = view.me!;
  const win = render(packFile(pack, `teams/${me.team}.md`), roleVars(rules)).replace(/^- /, '').trim();
  const facts: string[] = [];
  if (me.pack.length) facts.push(`- Your fellow werewolves: ${me.pack.map((w) => `${name(w.seat)} (seat ${w.seat}, ${roleLabel(w.role)})`).join(', ')}.`);
  if (me.infected) facts.push('- You were infected: you are secretly on the Werewolf team now, keeping your role and powers.');
  if (me.lover) facts.push(`- You are in love with ${name(me.lover.seat)} (seat ${me.lover.seat}${me.lover.role ? `, the ${roleLabel(me.lover.role)}` : ''}). If one of you dies, the other dies too.`);
  if (me.sister) facts.push(`- Your sister: ${name(me.sister)} (seat ${me.sister}).`);
  if (me.charmed) facts.push(`- You have been charmed by the Piper. Known charmed players: ${me.charmedKnown.map(name).join(', ')}.`);
  else if (me.role === 'piper' && me.charmedKnown.length) facts.push(`- Players you have charmed: ${me.charmedKnown.map(name).join(', ')}.`);
  if (me.role === 'witch') facts.push(`- Potions: healing ${me.usedHeal ? 'USED' : 'available'}, poison ${me.usedPoison ? 'USED' : 'available'}.`);
  if (view.sheriff === me.seat) facts.push('- You are the Sheriff: your vote counts double.');
  const mine = view.table[me.seat - 1];
  if (mine && !mine.canVote) facts.push('- You can no longer vote.');
  if (mine?.voteBanned) facts.push('- The Scapegoat has barred you from voting today.');
  const status = `${me.alive ? 'alive' : 'dead'}${me.powersActive ? '' : ', your special powers are lost'}`;
  return render(packFile(pack, 'card.md'), {
    name: me.name,
    seat: me.seat,
    role: roleLabel(me.role),
    team: me.team,
    wolf_nature: me.wolfNature ? ' (you have wolf nature: you count as a werewolf for the Seer, the Fox and the Bear)' : '',
    win,
    status,
    facts: facts.join('\n'),
  }).trim();
}

/** L2, the public state (JSON). Vote tables older than two days collapse to one line. */
export function publicState(view: GameView, cap: number, charsPerToken: number): string {
  const players = view.table.map((s) => ({
    seat: s.seat,
    name: s.name,
    alive: s.alive,
    revealed: s.revealed ? (s.revealed.role ? roleLabel(s.revealed.role) + (s.revealed.infected ? ' (infected)' : '') : `team ${s.revealed.team}`) : null,
    sheriff: s.sheriff || undefined,
    cannot_vote: !s.canVote || undefined,
    vote_banned_today: s.voteBanned || undefined,
    raven_marked: s.marked || undefined,
  }));
  const name = (n: number) => view.table[n - 1]?.name ?? `seat ${n}`;
  const named = (scores: Record<string, number>) => Object.fromEntries(Object.entries(scores).map(([seat, n]) => [name(Number(seat)), n]));
  const fullTable = (t: GameView['votes'][number]) => ({
    day: t.day,
    vote: t.context,
    ballots: t.ballots.map((b) => `${name(b.voter)}${b.weight > 1 ? ' (x2)' : ''} → ${b.vote === 'abstain' ? 'abstain' : name(b.vote)}`),
    totals: named(t.scores),
    abstentions: t.abstain,
  });
  // Only an execution vote can end in an execution; a Sheriff election never does.
  const EXECUTION_VOTES = ['day', 'runoff', 'second_vote', 'second_runoff'];
  const collapsed = (t: GameView['votes'][number]) => {
    const exec = EXECUTION_VOTES.includes(t.context) ? view.executions.find((x) => x.day === t.day) : undefined;
    const top = Object.entries(t.scores).sort((a, b) => b[1] - a[1])[0];
    return `day ${t.day} ${t.context}: ${top ? `top ${name(Number(top[0]))} with ${top[1]}` : 'no votes'} vs ${t.abstain} abstaining${exec ? `; ${name(exec.seat)} was executed that day` : ''}`;
  };
  const cycle = Math.max(view.day, 1);
  let history: unknown[] = view.votes.map((t) => (t.day >= cycle - 1 ? fullTable(t) : collapsed(t)));
  const state = () => ({
    day: view.day,
    night: view.night,
    phase: view.phase,
    players,
    alive_count: players.filter((p) => p.alive).length,
    sheriff: view.sheriff ? name(view.sheriff) : null,
    raven_mark: view.ravenMark ? name(view.ravenMark) : null,
    bear: view.bear ? `day ${view.bear.day}: ${view.bear.growls ? 'growled' : 'silent'}` : undefined,
    village_lost_powers: view.elderCurse || undefined,
    cards_in_game: view.composition.map(roleLabel),
    vote_history: history,
  });
  let text = JSON.stringify(state());
  // over the cap: drop the oldest collapsed lines (the player list and reveals are always kept)
  while (estimateTokens(text, charsPerToken) > cap && history.some((h) => typeof h === 'string')) {
    history = history.filter((h, i) => i !== history.findIndex((x) => typeof x === 'string'));
    text = JSON.stringify(state());
  }
  return text;
}

/** Seat-addressed entry types that belong to the private log (L4). */
const L4_SKIP = new Set(['REQUEST_OPENED', 'REQUEST_CLOSED', 'SEAT_THOUGHTS', 'FALLBACK_USED']);

interface PrivateItem {
  when: string;
  night: number;
  kind: 'notice' | 'council' | 'channel';
  speaker?: string;
  text: string;
  proposed?: string | null;
  ready?: boolean;
}

/**
 * L4, the private log: the seat's own ability results, the private channels it took part in
 * and private engine notices. Talk older than two nights is digested to its outcome; if still
 * over the cap, the oldest entries are dropped.
 */
export function privateLog(seatEntries: readonly ViewEntry[], name: NameOf, cap: number, charsPerToken: number): string {
  const items: PrivateItem[] = [];
  let currentNight = 0;
  for (const e of seatEntries) {
    currentNight = Math.max(currentNight, e.at.night);
    if (!e.private || L4_SKIP.has(e.type)) continue;
    const when = e.at.phase === 'night' || e.at.phase === 'dawn' ? `${e.at.phase} ${e.at.night}` : `${e.at.phase} ${e.at.day}`;
    if (e.type === 'COUNCIL_MSG') {
      const p = e.payload as EnginePayload<'COUNCIL_MSG'>;
      items.push({ when, night: e.at.night, kind: 'council', speaker: name(p.seat), text: p.message, proposed: p.proposed_target === null ? null : name(p.proposed_target), ready: p.ready });
    } else if (e.type === 'CHANNEL_MSG') {
      const p = e.payload as EnginePayload<'CHANNEL_MSG'>;
      items.push({ when, night: e.at.night, kind: 'channel', speaker: name(p.seat), text: p.message });
    } else {
      const text = describe(e, name);
      if (text) items.push({ when, night: e.at.night, kind: 'notice', text: `${ENGINE_OPEN} ${text} ${ENGINE_CLOSE}` });
    }
  }
  const fmt = (xs: PrivateItem[]) => JSON.stringify(xs.map(({ night: _n, ...rest }) => rest));
  let list = items;
  let text = fmt(list);
  if (estimateTokens(text, charsPerToken) > cap) {
    // 1. digest talk older than two nights to a count per night
    const out: PrivateItem[] = [];
    const counted = new Map<number, number>();
    for (const it of list) {
      if (it.kind !== 'notice' && it.night < currentNight - 1) {
        if (!counted.has(it.night)) out.push({ when: `night ${it.night}`, night: it.night, kind: 'notice', text: '' });
        counted.set(it.night, (counted.get(it.night) ?? 0) + 1);
      } else out.push(it);
    }
    for (const it of out) if (it.text === '' && it.kind === 'notice') it.text = `${ENGINE_OPEN} ${counted.get(it.night)} private messages that night (older talk is summarised) ${ENGINE_CLOSE}`;
    list = out;
    text = fmt(list);
    // 2. compact ability results older than two nights to a short line
    if (estimateTokens(text, charsPerToken) > cap) {
      list = list.map((it) => (it.kind === 'notice' && it.night < currentNight - 1 ? { ...it, text: compact(it.text) } : it));
      text = fmt(list);
    }
    // 3. only then drop the oldest entries until it fits
    while (estimateTokens(text, charsPerToken) > cap && list.length > 1) {
      list = list.slice(1);
      text = fmt(list);
    }
  }
  return text;
}

/** A one-line form of an old private notice ("Your vision: Bram is a WEREWOLF."). */
function compact(text: string): string {
  const bare = text.replace(ENGINE_OPEN, '').replace(ENGINE_CLOSE, '').trim();
  const short = bare.length <= 90 ? bare : `${bare.slice(0, 87)}...`;
  return `${ENGINE_OPEN} ${short} ${ENGINE_CLOSE}`;
}

/** L5: the seat's own latest notebook (from its SEAT_THOUGHTS), capped by the word limit. */
export function notebookOf(seatEntries: readonly ViewEntry[], seat: number, words: number): string | null {
  for (let i = seatEntries.length - 1; i >= 0; i--) {
    const e = seatEntries[i]!;
    if (e.type !== 'SEAT_THOUGHTS') continue;
    const p = e.payload as EnginePayload<'SEAT_THOUGHTS'>;
    if (p.seat === seat && p.notebook) return truncateWords(p.notebook, words).text;
  }
  return null;
}

/** Task-file key: the sheriff vote shares its context name with the sheriff speech. */
export const taskKey = (req: DecisionRequest): string => (req.kind === 'vote' && req.context === 'sheriff' ? 'sheriff_vote' : req.context);

/** The enumerated legal options (by display name) for the L6 task. */
export function optionsText(req: DecisionRequest, name: NameOf): string {
  const L = req.legal;
  const seats = (xs: readonly number[] | undefined) => (xs ?? []).map((n) => `${n} = ${name(n)}`).join(', ') || 'none';
  const lines: string[] = [];
  switch (req.kind) {
    case 'speech':
      lines.push(`Legal "lean" values: ${seats(L.leanTargets)}, or null.`);
      if (L.challengeTargets?.length) lines.push(`Legal "challenge" values: ${seats(L.challengeTargets)}, or null.`);
      break;
    case 'vote':
      lines.push(`Legal votes: ${seats(L.targets)}, or "abstain".`);
      if (L.secondVote) lines.push('You may also set "second_vote": true (secret, once per game) to call a second vote today.');
      break;
    case 'council_turn':
      lines.push(`Legal "proposed_target" values: ${seats(L.targets)}, or null.`);
      break;
    case 'council_ballot':
    case 'target':
      lines.push(`Legal targets: ${seats(L.targets)}${L.allowNone ? ', or null' : ''}.`);
      break;
    case 'witch':
      lines.push(L.canHeal && L.healTarget ? `"heal": true saves ${L.healTarget} = ${name(L.healTarget)}.` : '"heal" must be false (you cannot heal tonight).');
      lines.push(`Legal "poison" values: ${seats(L.poisonTargets)}, or null.`);
      break;
    case 'choice':
      lines.push(`Legal choices: ${(L.choices ?? []).map((c) => JSON.stringify(c)).join(', ')}.`);
      break;
    case 'pair':
      lines.push(`Pick exactly 2 different seats from: ${seats(L.targets)}.`);
      break;
    case 'multi':
      lines.push(`Pick between ${L.min ?? 0} and ${L.max ?? (L.targets ?? []).length} different seats from: ${seats(L.targets)}.`);
      break;
    case 'sheriff_run':
    case 'message':
      break;
  }
  return lines.join('\n');
}

export function taskVars(req: DecisionRequest, rules: ResolvedRules, seatEntries: readonly ViewEntry[], name: NameOf): Record<string, string | number> {
  const L = req.legal;
  let witchInfo = 'Nobody was attacked tonight.';
  for (let i = seatEntries.length - 1; i >= 0; i--) {
    const e = seatEntries[i]!;
    if (e.type === 'WITCH_INFO' && e.at.night === req.night) {
      const a = (e.payload as EnginePayload<'WITCH_INFO'>).attacked;
      witchInfo = a === null ? 'Nobody was attacked tonight.' : `Tonight the pack attacked ${name(a)} (seat ${a}).`;
      break;
    }
  }
  let challenger = 'a player';
  for (let i = seatEntries.length - 1; i >= 0; i--) {
    const e = seatEntries[i]!;
    if (e.type === 'CHALLENGE' && (e.payload as EnginePayload<'CHALLENGE'>).target === req.seat) {
      challenger = name((e.payload as EnginePayload<'CHALLENGE'>).seat);
      break;
    }
  }
  return {
    words: req.words ?? 0,
    round: req.round ?? 1,
    max_rounds: req.maxRounds ?? 1,
    min: L.min ?? 0,
    max: L.max ?? 0,
    judge_hint: L.secondVote ? ' As the Stuttering Judge you may also secretly call a second vote.' : '',
    skip_hint: rules.wolves_may_skip ? ' Proposing null with ready = true from every wolf means no kill tonight.' : '',
    ballot_none: L.allowNone ? ', or null for no kill' : '',
    target_none: L.allowNone ? ', or null for no kill' : '',
    witch_info: witchInfo,
    challenger,
    challenge_hint: L.challengeTargets?.length
      ? ' You still have a Challenge (limited per game): set "challenge" to a seat to call that player out, and they must answer you right after this speech. Save it for when it matters; otherwise null.'
      : '',
  };
}

