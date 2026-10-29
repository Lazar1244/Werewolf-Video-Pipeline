import { describeFor, roleLabel, type ViewEntry } from '@ww/projector';
import { h, replace } from '../dom';
import type { AppState } from '../app';
import { entries, view } from '../app';

/**
 * The story of the game: engine facts, what players said, and — for a spectator once the game
 * is open — what they were thinking. Player text is always shown as quoted, attributed speech.
 */
const DEATH = new Set(['DEATHS', 'EXECUTION', 'HUNTER_SHOT', 'ELDER_CURSE']);
const VOTEISH = new Set(['VOTES', 'RUNOFF', 'NO_EXECUTION', 'SHERIFF_RESULT', 'SECOND_VOTE', 'SCAPEGOAT_RULING', 'CHALLENGE']);
const SKIP = new Set(['REQUEST_OPENED', 'REQUEST_CLOSED', 'NIGHT_STEP_START', 'SEATING', 'DAY_SUMMARY']);

export function renderLog(body: HTMLElement, s: AppState): void {
  const v = view(s);
  const list = entries(s);
  if (!v || list.length === 0) {
    replace(body, h('p', { class: 'hint', text: 'The game has not started yet.' }));
    return;
  }
  const name = (n: number) => v.table[n - 1]?.name ?? `seat ${n}`;
  const nodes: HTMLElement[] = [];

  for (const e of list) {
    if (SKIP.has(e.type)) continue;
    if (e.type === 'PHASE_START') {
      nodes.push(h('div', { class: 'entry phase-sep', text: phaseTitle((e.payload as { phase: string }).phase, e) }));
      continue;
    }
    const node = entryNode(e, name, s);
    if (node) nodes.push(node);
  }
  // while nobody is asking this device anything, say what the table is doing
  const activity = activityLine(s);
  if (activity) nodes.push(h('div', { class: 'entry activity', text: activity }));
  const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 80;
  replace(body, ...nodes);
  if (atBottom) body.scrollTop = body.scrollHeight;
}

/** What is happening while the models think (public knowledge only: never who is acting). */
function activityLine(s: AppState): string | null {
  const v = view(s);
  if (!v || v.result || s.client.pending || s.client.status === 'aborted') return null;
  if (s.client.paused) return 'The game is paused.';
  if (v.phase === 'night') return 'Night: the roles act in secret…';
  if (v.phase === 'dawn') return 'Dawn: the village wakes up…';
  if (v.phase === 'dusk') return 'Dusk: the village is deciding…';
  if (v.phase === 'day') return 'The village is talking…';
  return 'The cards are being dealt…';
}

function phaseTitle(phase: string, e: ViewEntry): string {
  if (phase === 'night') return `Night ${e.at.night}`;
  if (phase === 'dawn') return `Dawn ${e.at.night}`;
  if (phase === 'day') return `Day ${e.at.day}`;
  return `Dusk ${e.at.day}`;
}

function entryNode(e: ViewEntry, name: (n: number) => string, s: AppState): HTMLElement | null {
  const meSeat = view(s)?.me?.seat;
  switch (e.type) {
    case 'SPEECH': {
      const p = e.payload as { seat: number; context: string; text: string; lean: number | null; claim: { role: string; result?: string } | null };
      return h(
        'div',
        { class: `entry speech${p.seat === meSeat ? ' mine' : ''}` },
        h('div', { class: 'head' }, h('span', { class: 'speaker', text: name(p.seat) }), h('span', { class: 'kind', text: speechKind(p.context) })),
        p.text.trim() === '(pass)' ? h('div', { class: 'text dim', text: 'passes without a word.' }) : h('div', { class: 'text', text: p.text }),
        p.lean !== null || p.claim
          ? h(
              'div',
              { class: 'meta' },
              p.lean !== null ? h('span', { class: 'badge', text: `suspects ${name(p.lean)}` }) : null,
              p.claim ? h('span', { class: 'badge', text: `claims to be the ${roleLabel(p.claim.role as Parameters<typeof roleLabel>[0])}${p.claim.result ? `: ${p.claim.result}` : ''}` }) : null,
            )
          : null,
      );
    }
    case 'SEAT_THOUGHTS': {
      const p = e.payload as { seat: number; reasoning: string };
      if (!p.reasoning.trim()) return null;
      return h('div', { class: 'entry thought', text: `${name(p.seat)} thinks: ${p.reasoning}` });
    }
    case 'COUNCIL_MSG': {
      const p = e.payload as { seat: number; message: string; proposed_target: number | null; ready: boolean };
      const tail = p.proposed_target === null ? 'no target yet' : `proposes ${name(p.proposed_target)}`;
      const said = p.message.trim() ? `${p.message} — ` : '';
      return h('div', { class: 'entry channel', text: `${name(p.seat)} (pack): ${said}${tail}${p.ready ? ', ready' : ''}` });
    }
    case 'CHANNEL_MSG': {
      const p = e.payload as { seat: number; message: string; channel: string };
      if (!p.message) return null;
      return h('div', { class: `entry channel ${p.channel}`, text: `${name(p.seat)} (${p.channel}): ${p.message}` });
    }
    // Lines that only a spectator's feed carries, or that the AI transcripts do not need: they
    // are written here rather than in `describe`, which also feeds the models' context.
    case 'DEATH_CAUSES': {
      const p = e.payload as { deaths: { seat: number; causes: string[] }[] };
      const text = p.deaths.map((d) => `${name(d.seat)}: ${d.causes.map((c) => CAUSE[c] ?? c).join(' and ')}`).join('; ');
      return text ? h('div', { class: 'entry engine death small', text: `How they died — ${text}.` }) : null;
    }
    case 'FALLBACK_USED': {
      const p = e.payload as { seat: number; context: string; reason: string };
      if (p.seat === 0) return null;
      return h('div', { class: 'entry engine small', text: `${name(p.seat)} ${FALLBACK_WHY[p.reason] ?? 'gave no usable answer'}, so the default choice was made for them.` });
    }
    case 'HUNTER_NO_SHOT':
      return h('div', { class: 'entry engine', text: `The Hunter ${name((e.payload as { hunter: number }).hunter)} did not shoot anyone.` });
    case 'COUNCIL_SKIPPED':
      return h('div', { class: 'entry channel', text: `The pack held no council tonight (${(e.payload as { reason: string }).reason.replace(/_/g, ' ')}).` });
    case 'DEBRIEF_OPENED':
      return h('div', { class: 'entry phase-sep', text: 'Debrief' });
    case 'DEBRIEF_DECLINED':
      return h('div', { class: 'entry engine small', text: 'The host skipped the debrief.' });
    case 'DEBRIEF_COMMENT': {
      const p = e.payload as { seat: number; text: string; round: number };
      return h('div', { class: 'entry speech' }, h('div', { class: 'head' }, h('span', { class: 'speaker', text: name(p.seat) }), h('span', { class: 'kind', text: 'debrief' })), h('div', { class: 'text', text: p.text }));
    }
    default: {
      // a notice addressed to someone else is told about them, not to them
      const text = describeFor(e, name, meSeat ?? null, e.seats);
      if (!text) return null;
      const cls = DEATH.has(e.type) ? 'death' : VOTEISH.has(e.type) ? 'vote' : '';
      return h('div', { class: `entry engine ${cls}`.trim(), text });
    }
  }
}

/** Why a default answer was used (the engine's no-answer reasons). */
const FALLBACK_WHY: Record<string, string> = {
  timeout: 'did not answer in time',
  invalid: 'gave an answer that could not be used',
  provider_error: 'could not be reached (the model provider failed)',
  disconnected: 'was offline',
  aborted: 'was cut off when the game stopped',
  forced: 'was skipped by the host',
};

const CAUSE: Record<string, string> = {
  attack: 'killed by the pack',
  bbw: 'killed by the Big Bad Wolf',
  white_wolf: 'killed by the White Werewolf',
  poison: "the Witch's poison",
  knight_curse: "the Knight's curse",
  heartbreak: 'died of heartbreak',
  hunter: "the Hunter's shot",
  execution: 'executed by the village',
};

const speechKind = (context: string): string =>
  ({ discussion: 'speaks', sheriff: 'campaigns', rebuttal: 'answers', defence: 'defends', last_words: 'last words', judge_round: 'second vote', challenge_answer: 'answers the challenge' })[context] ?? context;
