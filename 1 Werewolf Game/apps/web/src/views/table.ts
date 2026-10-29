import type { GameView } from '@ww/client-sdk';
import { h, replace } from '../dom';
import type { AppState } from '../app';
import { pending, view } from '../app';

/**
 * The table: every seat, alive or dead, with what this viewer is allowed to know.
 * When a decision needs a target, the seats become the buttons for it.
 */
export interface TableHandlers {
  onPick: (seat: number) => void;
}

export function renderTable(body: HTMLElement, s: AppState, handlers: TableHandlers): void {
  const v = view(s);
  if (!v) {
    replace(body, h('p', { class: 'hint', text: 'Waiting for the game to start…' }));
    return;
  }
  const req = pending(s);
  const legal = (req?.legal ?? {}) as { targets?: number[]; leanTargets?: number[]; poisonTargets?: number[] };
  const pickable = new Set<number>(pickTargets(s, legal));
  const chosen = new Set<number>(chosenSeats(s));
  const me = v.me;
  // which model plays each seat: only ever sent once the game is open to this viewer (§9, §15b)
  const modelOf = new Map(s.client.models.map((m) => [m.seat, m.label]));

  const cards = cardsLine(v.composition);
  replace(
    body,
    cards ? h('div', { class: 'cards-line small', text: cards }) : null,
    ...v.table.map((p) => {
      const cls = ['seat'];
      if (me && p.seat === me.seat) cls.push('me');
      if (!p.alive) cls.push('dead');
      if (pickable.has(p.seat)) cls.push('target');
      if (chosen.has(p.seat)) cls.push('chosen');
      const sub = subtitle(v, p);
      const model = modelOf.get(p.seat);
      return h(
        'div',
        {
          class: cls.join(' '),
          ...(pickable.has(p.seat)
            ? {
                onclick: () => handlers.onPick(p.seat),
                // a seat that acts as a button behaves like one from the keyboard too
                onkeydown: (e: Event) => {
                  const key = (e as KeyboardEvent).key;
                  if (key === 'Enter' || key === ' ') {
                    e.preventDefault();
                    handlers.onPick(p.seat);
                  }
                },
                role: 'button',
                tabindex: 0,
                'aria-label': `Choose ${p.name}`,
              }
            : {}),
        },
        h('div', { class: 'num', text: String(p.seat) }),
        h(
          'div',
          { class: 'who' },
          h('div', { class: 'name', text: p.name }),
          sub ? h('div', { class: 'sub', text: sub }) : null,
          model ? h('div', { class: 'model', text: model }) : null,
        ),
        h(
          'div',
          { class: 'badges' },
          p.sheriff ? h('span', { class: 'badge sheriff', text: 'Sheriff', title: 'Their vote counts double' }) : null,
          p.marked ? h('span', { class: 'badge marked', text: '+2', title: 'Marked by the Raven for today’s vote' }) : null,
          !p.canVote && p.alive ? h('span', { class: 'badge', text: 'no vote' }) : null,
          p.voteBanned && p.alive ? h('span', { class: 'badge', text: 'barred today' }) : null,
          me && me.pack.some((w) => w.seat === p.seat) ? h('span', { class: 'badge wolf', text: 'pack' }) : null,
          // a viewer the game is open to is shown each seat's team, so the table is followable
          p.known && !p.revealed && p.seat !== me?.seat ? h('span', { class: `badge${p.known.team === 'Werewolf' ? ' wolf' : ''}`, text: p.known.team }) : null,
          me && me.lover?.seat === p.seat ? h('span', { class: 'badge', text: '♥' }) : null,
          me && me.sister === p.seat ? h('span', { class: 'badge', text: 'sister' }) : null,
        ),
      );
    }),
  );
}

/** "Cards in play: 2 Werewolf, Seer, Witch …" — public from the first moment (GAME_START). */
function cardsLine(composition: readonly string[]): string {
  if (!composition.length) return '';
  const counts = new Map<string, number>();
  for (const c of composition) counts.set(c, (counts.get(c) ?? 0) + 1);
  return `Cards in play: ${[...counts].map(([c, n]) => `${n > 1 ? `${n} ` : ''}${roleLabel(c)}`).join(', ')}`;
}

/** What is publicly known about a seat, in a few words. */
function subtitle(v: GameView, p: GameView['table'][number]): string {
  const card = p.revealed?.role ? { role: p.revealed.role, infected: p.revealed.infected } : p.known ? { role: p.known.role, infected: p.known.infected } : null;
  if (card) return `${!p.alive ? 'dead — ' : ''}${roleLabel(card.role)}${card.infected ? ' (infected)' : ''}`;
  if (p.revealed?.team) return `${!p.alive ? 'dead — ' : ''}team ${p.revealed.team}`;
  if (!p.alive) return 'dead';
  void v;
  return '';
}

const roleLabel = (id: string): string => id.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/** Seats this request can be pointed at (so the table can act as the picker). */
export function pickTargets(s: AppState, legal: { targets?: number[]; leanTargets?: number[]; poisonTargets?: number[] }): number[] {
  const req = pending(s);
  if (!req || s.draft.sent) return [];
  switch (req.kind) {
    case 'vote':
    case 'target':
    case 'council_ballot':
    case 'council_turn':
    case 'pair':
    case 'multi':
      return legal.targets ?? [];
    case 'witch': {
      // the player being healed cannot also be poisoned, so the table does not offer it either
      const heal = ((req.legal ?? {}) as { healTarget?: number | null }).healTarget;
      return (legal.poisonTargets ?? []).filter((t) => !(s.draft.heal && t === heal));
    }
    case 'speech':
      return legal.leanTargets ?? [];
    default:
      return [];
  }
}

function chosenSeats(s: AppState): number[] {
  const d = s.draft;
  const req = pending(s);
  if (!req) return [];
  if (req.kind === 'speech') return d.lean === null ? [] : [d.lean];
  if (req.kind === 'multi' || req.kind === 'pair') return d.multi;
  if (req.kind === 'witch') return typeof d.target === 'number' ? [d.target] : [];
  return typeof d.target === 'number' ? [d.target] : [];
}
