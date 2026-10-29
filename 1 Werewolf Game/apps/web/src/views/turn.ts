import type { ClientRequest } from '@ww/client-sdk';
import { roleLabel } from '@ww/projector';
import { h, humanMs, replace, words } from '../dom';
import type { AppState, Draft } from '../app';
import { entries, pending, view } from '../app';

/**
 * "Your turn": what the game is asking, the legal options, and the answer being written.
 * The panel is rebuilt only when the request changes, so typing is never interrupted.
 */
export interface TurnHandlers {
  change: (patch: Partial<Draft>) => void;
  submit: () => void;
}

interface Legal {
  targets?: number[];
  allowNone?: boolean;
  leanTargets?: number[];
  /** Present only while this player still has a Challenge (ruleset §9.2). */
  challengeTargets?: number[];
  choices?: string[];
  canHeal?: boolean;
  healTarget?: number | null;
  poisonTargets?: number[];
  min?: number;
  max?: number;
  secondVote?: boolean;
}

export function renderTurn(body: HTMLElement, s: AppState, hnd: TurnHandlers): void {
  const req = pending(s);
  const v = view(s);
  if (!req || !v) {
    replace(
      body,
      s.turnNote ? h('div', { class: 'banner', text: s.turnNote }) : null,
      h('p', { class: 'hint', text: s.isSeat ? 'Nothing to do right now. Watch the table.' : 'You are watching this game.' }),
    );
    return;
  }
  const legal = (req.legal ?? {}) as Legal;
  const name = (n: number) => v.table[n - 1]?.name ?? `seat ${n}`;
  const d = s.draft;
  const challenger = req.context === 'challenge_answer' ? challengerOf(s, v.me?.seat) : null;
  const nodes: (HTMLElement | null)[] = [
    s.turnNote ? h('div', { class: 'banner', text: s.turnNote }) : null,
    h('p', { class: 'ask', text: ask(req, name, legal, challenger === null ? null : name(challenger)) }),
  ];
  // typing must not rebuild the panel (it would move the caret), so the Send button is kept in
  // step with the text by hand — an over-long answer would be cut by the engine, so it is refused here
  const send = h('button', { class: 'primary' }, 'Send');
  const syncSend = (text: string) => {
    const blocked = d.sent || !canSubmit(s) || overWords(req, text);
    if (blocked) send.setAttribute('disabled', 'disabled');
    else send.removeAttribute('disabled');
  };

  switch (req.kind) {
    case 'speech': {
      const debrief = req.context.startsWith('debrief');
      nodes.push(textArea(d, req, hnd, debrief ? 'One comment about the game (leave empty to say nothing)' : 'What do you say?', syncSend));
      // the debrief comes after the game: there is nobody left to suspect and nothing to claim
      if (!debrief) {
        nodes.push(
          h(
            'div',
            { class: 'options' },
            h('span', { class: 'hint', text: 'Who do you suspect?' }),
            ...(legal.leanTargets ?? []).map((t) => button(name(t), d.lean === t, () => hnd.change({ lean: d.lean === t ? null : t }))),
            button('nobody', d.lean === null, () => hnd.change({ lean: null })),
          ),
        );
        if (legal.challengeTargets?.length) {
          nodes.push(
            h(
              'div',
              { class: 'options' },
              h('span', { class: 'hint', text: 'Challenge someone? (limited per game: they must answer you right away)' }),
              ...legal.challengeTargets.map((t) => button(name(t), d.challenge === t, () => hnd.change({ challenge: d.challenge === t ? null : t }))),
              button('no challenge', d.challenge === null, () => hnd.change({ challenge: null })),
            ),
          );
        }
        nodes.push(claimRow(d, hnd, v.composition));
      }
      break;
    }
    case 'vote': {
      nodes.push(
        h(
          'div',
          { class: 'options' },
          ...(legal.targets ?? []).map((t) => button(name(t), d.target === t, () => hnd.change({ target: t, touched: true }))),
          button('abstain', d.target === 'abstain', () => hnd.change({ target: 'abstain', touched: true })),
        ),
      );
      if (legal.secondVote) {
        nodes.push(
          h(
            'label',
            { class: 'row small' },
            h('input', { type: 'checkbox', 'aria-label': 'Secretly call a second vote today', ...(d.ready ? { checked: 'checked' } : {}), onchange: (e: Event) => hnd.change({ ready: (e.target as HTMLInputElement).checked }) }),
            ' Secretly call a second vote today (Stuttering Judge, once per game)',
          ),
        );
      }
      break;
    }
    case 'target':
    case 'council_ballot': {
      nodes.push(
        h(
          'div',
          { class: 'options' },
          ...(legal.targets ?? []).map((t) => button(name(t), d.target === t, () => hnd.change({ target: t, touched: true }))),
          legal.allowNone ? button('nobody', d.target === null && d.touched, () => hnd.change({ target: null, touched: true })) : null,
        ),
      );
      break;
    }
    case 'council_turn': {
      nodes.push(textArea(d, req, hnd, 'What do you tell the pack?', syncSend));
      nodes.push(
        h(
          'div',
          { class: 'options' },
          h('span', { class: 'hint', text: 'Propose tonight’s victim:' }),
          ...(legal.targets ?? []).map((t) => button(name(t), d.target === t, () => hnd.change({ target: t, touched: true }))),
          button('no proposal', d.target === null && d.touched, () => hnd.change({ target: null, touched: true })),
        ),
      );
      nodes.push(
        h(
          'label',
          { class: 'row small' },
          h('input', { type: 'checkbox', 'aria-label': 'I am happy to lock this target', ...(d.ready ? { checked: 'checked' } : {}), onchange: (e: Event) => hnd.change({ ready: (e.target as HTMLInputElement).checked }) }),
          ' I am happy to lock this target',
        ),
      );
      break;
    }
    case 'witch': {
      nodes.push(
        h(
          'div',
          { class: 'options' },
          legal.canHeal && legal.healTarget
            ? button(`heal ${name(legal.healTarget)}`, d.heal, () => hnd.change({ heal: !d.heal, ...(!d.heal && d.target === legal.healTarget ? { target: null } : {}) }))
            : h('span', { class: 'hint', text: 'You cannot use the healing potion tonight.' }),
        ),
      );
      nodes.push(
        h(
          'div',
          { class: 'options' },
          h('span', { class: 'hint', text: 'Poison:' }),
          // the player being healed cannot also be poisoned
          ...(legal.poisonTargets ?? []).filter((t) => !(d.heal && t === legal.healTarget)).map((t) => button(name(t), d.target === t, () => hnd.change({ target: t, touched: true }))),
          button('nobody', d.target === null && d.touched, () => hnd.change({ target: null, touched: true })),
        ),
      );
      break;
    }
    case 'choice': {
      const offer = thiefOffer(s);
      nodes.push(h('div', { class: 'options' }, ...(legal.choices ?? []).map((c) => button(choiceLabel(c, offer), d.choice === c, () => hnd.change({ choice: c })))));
      break;
    }
    case 'pair':
    case 'multi': {
      const min = legal.min ?? (req.kind === 'pair' ? 2 : 0);
      const max = legal.max ?? (req.kind === 'pair' ? 2 : (legal.targets ?? []).length);
      nodes.push(
        h(
          'div',
          { class: 'options' },
          ...(legal.targets ?? []).map((t) =>
            button(name(t), d.multi.includes(t), () => {
              const has = d.multi.includes(t);
              const next = has ? d.multi.filter((x) => x !== t) : [...d.multi, t].slice(-Math.max(1, max));
              hnd.change({ multi: next });
            }),
          ),
        ),
      );
      nodes.push(h('p', { class: 'hint', text: `Choose ${min === max ? String(min) : `${min}–${max}`} player${max === 1 ? '' : 's'} (${d.multi.length} chosen).` }));
      break;
    }
    case 'sheriff_run': {
      nodes.push(h('div', { class: 'options' }, button('I run for Sheriff', d.run === true, () => hnd.change({ run: true })), button('I stay out', d.run === false, () => hnd.change({ run: false }))));
      break;
    }
    case 'message': {
      nodes.push(textArea(d, req, hnd, 'Your private message (leave empty to say nothing)', syncSend));
      break;
    }
  }

  send.textContent = d.sent ? 'Sent' : 'Send';
  send.onclick = () => hnd.submit();
  syncSend(d.text);
  nodes.push(
    h(
      'div',
      { class: 'row mt' },
      send,
      // "Skip" is only offered where doing nothing is a legal answer, and it sends that answer
      // rather than whatever was half-chosen
      req.optional && !d.sent && skippable(req, legal) ? h('button', { class: 'ghost', onclick: () => skip(hnd) }, 'Skip') : null,
    ),
  );
  if (s.issues.length) nodes.push(h('div', { class: 'issues', text: `Not accepted: ${s.issues.map((i) => plainIssue(i, name)).join('; ')}` }));
  replace(body, ...nodes.filter(Boolean));
}

/**
 * The countdown bar, with the time left written on it (a phone has no hover). It is measured on
 * this device from what the server said was left, so a phone with a wrong clock still counts
 * down correctly. Updated on its own, so the rest of the panel is left alone.
 */
export function renderTimer(bar: HTMLElement, req: ClientRequest | null, timing: AppState['timing'], now = Date.now()): void {
  if (!req || !timing || timing.id !== req.clientRequestId) {
    bar.className = 'timer';
    bar.title = '';
    replace(bar);
    return;
  }
  if (timing.deadline === null) {
    bar.className = 'timer frozen';
    bar.title = 'The game is paused: your time is frozen.';
    replace(bar, h('i', { style: 'width:100%' }), h('span', { class: 'left', text: 'paused — your time is frozen' }));
    return;
  }
  const left = Math.max(0, timing.deadline - now);
  const pct = Math.max(0, Math.min(100, (left / Math.max(1, timing.totalMs)) * 100));
  bar.className = `timer${left < 15000 ? ' urgent' : ''}`;
  bar.title = `${humanMs(left)} left`;
  replace(bar, h('i', { style: `width:${pct}%` }), h('span', { class: 'left', text: `${humanMs(left)} left` }));
}

function textArea(d: Draft, req: ClientRequest, hnd: TurnHandlers, placeholder = 'What do you say?', onText?: (text: string) => void): HTMLElement {
  const limit = req.words ?? 0;
  const counter = limit ? h('div', { class: 'words' }) : null;
  const paint = (text: string): void => {
    if (!counter) return;
    const count = words(text);
    counter.className = `words${count > limit ? ' over' : ''}`;
    counter.textContent = count > limit ? `${count} / ${limit} words — too long to send` : `${count} / ${limit} words`;
  };
  const ta = h('textarea', {
    rows: 4,
    placeholder,
    oninput: (e: Event) => {
      const text = (e.target as HTMLTextAreaElement).value;
      paint(text);
      hnd.change({ text });
      onText?.(text);
    },
  });
  ta.value = d.text;
  paint(d.text);
  return h('div', {}, ta, counter);
}

/**
 * A speech may carry a role claim, the same way a model's answer can (ruleset §9.2). The roles
 * offered are the cards in this game, so a claim is always one the engine will accept.
 */
function claimRow(d: Draft, hnd: TurnHandlers, composition: readonly string[]): HTMLElement {
  const cards = [...new Set(composition)].sort();
  const role = h(
    'select',
    { onchange: (e: Event) => hnd.change({ claimRole: (e.target as HTMLSelectElement).value || null }) },
    h('option', { value: '', ...(d.claimRole ? {} : { selected: 'selected' }) }, 'claim nothing'),
    ...cards.map((c) => h('option', { value: c, ...(d.claimRole === c ? { selected: 'selected' } : {}) }, roleLabel(c as Parameters<typeof roleLabel>[0]))),
  );
  const result = h('input', { type: 'text', placeholder: 'what it told you (optional)', value: d.claimResult, onchange: (e: Event) => hnd.change({ claimResult: (e.target as HTMLInputElement).value }) });
  return h('div', { class: 'row small' }, h('span', { class: 'hint', text: 'Claim a role:' }), role, d.claimRole ? result : null);
}

/** The word limit is a hard limit: over it the engine would cut the end off silently. */
const overWords = (req: ClientRequest, text: string): boolean => !!req.words && words(text) > req.words;

/** Requests where saying nothing at all is a legal answer. */
function skippable(req: ClientRequest, legal: Legal): boolean {
  switch (req.kind) {
    case 'witch':
    case 'message':
    case 'speech':
    case 'council_turn':
      return true;
    case 'target':
    case 'council_ballot':
      return legal.allowNone === true;
    case 'multi':
      return (legal.min ?? 0) === 0;
    default:
      return false;
  }
}

/** Skipping answers with nothing, not with whatever was half-chosen. */
function skip(hnd: TurnHandlers): void {
  hnd.change({ text: '', target: null, multi: [], heal: false, choice: null, run: null, lean: null, challenge: null, claimRole: null, claimResult: '', touched: true });
  hnd.submit();
}

/** The two cards the Thief was shown, from this player's own feed (ruleset §10). */
function thiefOffer(s: AppState): [string, string] | null {
  const e = [...entries(s)].reverse().find((x) => x.type === 'THIEF_OFFER');
  const extras = (e?.payload as { extras?: [string, string] } | undefined)?.extras;
  return extras ?? null;
}

/** The engine's refusal, in words a player understands: codes explained, seat numbers named. */
function plainIssue(issue: string, name: (n: number) => string): string {
  const known: Record<string, string> = {
    not_waiting_for_this: 'this question has already been settled, so your answer was not needed',
  };
  const key = issue.split(':')[0]!.trim();
  if (known[key]) return known[key];
  return issue
    .replace(/\[([\d,\s]+)\]/g, (_, list: string) => list.split(',').map((x) => name(Number(x.trim()))).join(', '))
    .replace(/\bseat (\d+)\b/g, (_, n: string) => name(Number(n)))
    .replace(/_/g, ' ');
}

function button(label: string, selected: boolean, onclick: () => void): HTMLElement {
  return h('button', { class: selected ? 'selected' : '', onclick }, label);
}

const choiceLabel = (c: string, offer: [string, string] | null = null): string =>
  ({
    keep: 'keep my card',
    extra1: offer ? `take the ${roleLabel(offer[0] as Parameters<typeof roleLabel>[0])}` : 'take the first card',
    extra2: offer ? `take the ${roleLabel(offer[1] as Parameters<typeof roleLabel>[0])}` : 'take the second card',
    spy: 'spy on the wolves',
    sleep: 'sleep safely',
    infect: 'infect them',
    kill: 'kill them',
    Village: 'join the village',
    Werewolf: 'join the wolves',
    open: 'open the debrief',
    skip: 'no debrief',
  })[c] ?? c;

/** Has the player given enough for this request to be worth sending? */
export function canSubmit(s: AppState): boolean {
  const req = pending(s);
  if (!req || s.draft.sent) return false;
  const d = s.draft;
  const legal = (req.legal ?? {}) as Legal;
  switch (req.kind) {
    case 'vote':
      // "abstain" is a button like any other: nothing is cast until the player picks one
      return d.target !== null;
    case 'target':
    case 'council_ballot':
      // "nobody" counts only when the player chose it; a Seer who presses Send too early must
      // not lose the night's vision
      return typeof d.target === 'number' || (d.touched && legal.allowNone === true);
    case 'choice':
      return d.choice !== null;
    case 'sheriff_run':
      return d.run !== null;
    case 'pair':
      return d.multi.length === 2;
    case 'multi':
      return d.multi.length >= (legal.min ?? 0);
    default:
      return true;
  }
}

/** The decision, in the shape the engine expects. */
export function buildDecision(s: AppState): Record<string, unknown> {
  const req = pending(s)!;
  const d = s.draft;
  switch (req.kind) {
    case 'speech':
      return {
        speech: d.text.trim() || '(pass)',
        lean: d.lean,
        ...(d.challenge !== null && ((req.legal ?? {}) as Legal).challengeTargets?.includes(d.challenge) ? { challenge: d.challenge } : {}),
        claim: d.claimRole ? { role: d.claimRole, ...(d.claimResult.trim() ? { result: d.claimResult.trim() } : {}) } : null,
      };
    case 'vote':
      return { vote: d.target === null ? 'abstain' : d.target, ...(((req.legal ?? {}) as Legal).secondVote && d.ready ? { second_vote: true } : {}) };
    case 'target':
    case 'council_ballot':
      return { target: typeof d.target === 'number' ? d.target : null };
    case 'council_turn':
      return { message: d.text.trim(), proposed_target: typeof d.target === 'number' ? d.target : null, ready: d.ready };
    case 'witch':
      return { heal: d.heal, poison: typeof d.target === 'number' ? d.target : null };
    case 'choice':
      return { choice: d.choice ?? '' };
    case 'pair':
    case 'multi':
      return { targets: d.multi };
    case 'sheriff_run':
      return { run: d.run === true };
    case 'message':
      return { message: d.text.trim() };
    default:
      return {};
  }
}

/** One plain sentence telling the player what is being asked of them. */
/** Who called this player out: the latest CHALLENGE in their feed aimed at them (ruleset §9.2). */
function challengerOf(s: AppState, me: number | undefined): number | null {
  const e = [...entries(s)].reverse().find((x) => x.type === 'CHALLENGE' && (x.payload as { target?: number }).target === me);
  return e ? (e.payload as { seat: number }).seat : null;
}

function ask(req: ClientRequest, name: (n: number) => string, legal: Legal, challenger: string | null = null): string {
  switch (req.context) {
    case 'discussion':
      return `Your turn to speak — round ${req.round ?? 1} of ${req.maxRounds ?? 1}.`;
    case 'sheriff':
      return req.kind === 'vote' ? 'Vote for the Sheriff.' : 'You are standing for Sheriff: make your case.';
    case 'sheriff_runoff':
      return 'The Sheriff vote is tied: vote again between the tied candidates.';
    case 'rebuttal':
      return 'You drew the most suspicion. Answer it before the vote.';
    case 'challenge_answer':
      return `${challenger ? `${challenger} challenged you!` : 'You have been challenged!'} Answer right away, before the next speaker.`;
    case 'defence':
      return 'You are up for execution. Defend yourself.';
    case 'last_words':
      return 'You are about to die. Any last words?';
    case 'judge_round':
      return 'A second vote was called. Say your piece.';
    case 'day':
      return 'Vote: who should the village execute?';
    case 'runoff':
      return 'Runoff vote between the tied players.';
    case 'second_vote':
    case 'second_runoff':
      return 'The second vote of the day.';
    case 'sheriff_run':
      return 'Do you want to run for Sheriff? The badge votes twice.';
    case 'council':
      return `Wolf council, round ${req.round ?? 1} of ${req.maxRounds ?? 1}. Agree on tonight's victim.`;
    case 'council_ballot':
      return 'The pack did not agree: cast your sealed ballot.';
    case 'wolf_kill':
      return 'You hunt alone tonight. Choose your victim.';
    case 'pack_tiebreak':
      return 'You lead the pack and the ballot is tied. Decide.';
    case 'protector':
      return 'Who do you protect tonight?';
    case 'seer':
      return 'Who do you look at tonight?';
    case 'fox':
      return 'Who do you sniff? You learn whether a wolf is among them or their neighbours.';
    case 'witch':
      return legal.healTarget ? `The wolves attacked ${name(legal.healTarget)}.` : 'Nobody was attacked tonight.';
    case 'big_bad_wolf':
      return 'You may take a second victim tonight.';
    case 'white_werewolf':
      return 'You may kill one of your own pack tonight.';
    case 'raven':
      return 'Mark someone for tomorrow’s vote (+2 against them).';
    case 'wild_child':
      return 'Choose your role model. If they die, you join the wolves.';
    case 'hunter_shot':
      return 'You are dying — take someone with you.';
    case 'sheriff_successor':
      return 'You are dying. Who gets the badge?';
    case 'thief':
      return 'Two cards were set aside for you. Keep yours, or take one?';
    case 'wolf_hound':
      return 'Choose your side.';
    case 'little_girl':
      return 'Spy on the wolves tonight, or sleep?';
    case 'wolf_father':
      return 'Infect tonight’s victim instead of killing them?';
    case 'cupid':
      return 'Choose the two lovers.';
    case 'piper':
      return 'Charm up to two players.';
    case 'scapegoat_ruling':
      return 'You were executed on a tie. Choose who may vote tomorrow.';
    case 'lovers_channel':
      return 'A private word with your lover.';
    case 'sisters_channel':
      return 'A private word with your sister.';
    case 'debrief_comment':
      return 'The game is over. One comment: your mistake, someone else’s play, a tip for next time.';
    case 'debrief_reply':
      return 'Any reply to the others?';
    default:
      return 'Your turn.';
  }
}
