import { roleLabel } from '@ww/projector';
import { h, replace } from '../dom';
import { entries, view, type AppState } from '../app';

/**
 * "You died": the moment a player's own seat falls, a full-screen notice says so, how, and what
 * happens now. It only uses what this player was told: the public DEATHS / EXECUTION /
 * HUNTER_SHOT entries, and the exact causes (DEATH_CAUSES) once the game is open to them.
 */
export interface DeathNotice {
  seat: number;
  /** "Killed by the werewolves", or as close as this player is allowed to know. */
  headline: string;
  /** "Night 1" or "Day 2". */
  when: string;
  /** Claw marks on the screen: a wolf did it. */
  wolves: boolean;
  /** The card they held, as the table now sees it. */
  role: string;
  /** What is left for them to do. */
  after: string;
  /** The button that closes the notice. */
  button: string;
}

const HOW: Record<string, string> = {
  attack: 'killed by the werewolves',
  bbw: 'killed by the Big Bad Wolf',
  white_wolf: 'killed by the White Werewolf',
  poison: 'poisoned by the Witch',
  knight_curse: "struck down by the Knight's curse",
  heartbreak: 'died of a broken heart',
  hunter: 'shot by the Hunter',
  execution: 'executed by the village',
};
const WOLF_CAUSES = new Set(['attack', 'bbw', 'white_wolf']);

const cap = (t: string): string => t.charAt(0).toUpperCase() + t.slice(1);

/** The notice for this device's own seat, or null while it lives (or has no seat). */
export function deathNotice(s: AppState): DeathNotice | null {
  const v = view(s);
  const me = v?.me;
  if (!v || !me || me.alive) return null;
  const log = entries(s);
  const name = (seat: number) => v.table.find((p) => p.seat === seat)?.name ?? `Seat ${seat}`;
  let died: (typeof log)[number] | undefined;
  let causes: string[] | null = null;
  let hunter: number | null = null;
  let execution: { scapegoat?: boolean } | null = null;
  for (const e of log) {
    if (e.type === 'DEATHS' && (e.payload as { deaths: { seat: number }[] }).deaths.some((d) => d.seat === me.seat)) died = e;
    if (e.type === 'DEATH_CAUSES') {
      const mine = (e.payload as { deaths: { seat: number; causes: string[] }[] }).deaths.find((d) => d.seat === me.seat);
      if (mine) causes = mine.causes;
    }
    if (e.type === 'HUNTER_SHOT' && (e.payload as { target: number }).target === me.seat) hunter = (e.payload as { hunter: number }).hunter;
    if (e.type === 'EXECUTION' && (e.payload as { seat: number }).seat === me.seat) execution = e.payload as { scapegoat?: boolean };
  }
  const at = died?.at;
  const night = at ? at.phase === 'night' || at.phase === 'dawn' : false;
  const when = !at ? '' : night ? `Night ${at.night}` : `Day ${at.day}`;

  let headline: string;
  let wolves = false;
  if (causes?.length) {
    // the exact story, once the game is open to this player
    headline = cap(causes.map((c) => (c === 'hunter' && hunter !== null ? `shot by the Hunter, ${name(hunter)}` : (HOW[c] ?? c.replace(/_/g, ' ')))).join(' and '));
    wolves = causes.some((c) => WOLF_CAUSES.has(c));
  } else if (hunter !== null) headline = `Shot by the Hunter, ${name(hunter)}`;
  else if (execution) headline = execution.scapegoat ? 'Executed by the village: as the Scapegoat, you took the blame for the tie' : 'Executed by the village';
  else if (night) headline = 'Found dead at dawn'; // wolves, or another night power: the table is not told which
  else headline = 'You are out of the game';

  const after = s.client.pending && !v.result
    ? 'But you are not done yet: you have one last action to take.'
    : v.result
      ? 'The game is over.'
      : s.client.lockOpen
        ? 'The game is open to you now: every card and every secret thought. Enjoy the show.'
        : 'You can keep watching, but you can no longer speak or vote.';
  const button = s.client.pending && !v.result ? 'Take my last action' : v.result ? 'See how it ended' : 'Keep watching';
  return { seat: me.seat, headline, when, wolves, role: roleLabel(me.role), after, button };
}

/** Three slashes torn across the screen, for a wolf kill. */
function claws(): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', 'claws');
  svg.setAttribute('viewBox', '0 0 200 200');
  svg.setAttribute('aria-hidden', 'true');
  for (const [i, d] of ['M40 20 C70 80 90 130 110 185', 'M80 10 C105 75 125 125 145 190', 'M120 15 C140 70 158 120 175 170'].entries()) {
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', d);
    path.setAttribute('style', `animation-delay:${0.15 + i * 0.12}s`);
    svg.appendChild(path);
  }
  return svg;
}

/**
 * Fill the overlay with a notice. `fresh` plays the entrance; a later update (the exact cause
 * arriving once the game opens) only swaps the words.
 */
export function renderDeath(el: HTMLElement, n: DeathNotice, fresh: boolean, onClose: () => void): void {
  el.className = `death-overlay${fresh ? '' : ' settled'}`;
  el.setAttribute('role', 'alertdialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-labelledby', 'death-title');
  el.setAttribute('aria-describedby', 'death-how');
  const button = h('button', { class: 'primary', onclick: onClose }, n.button);
  replace(
    el,
    n.wolves ? claws() : null,
    h(
      'div',
      { class: 'death-card' },
      h('h1', { id: 'death-title', text: 'You died' }),
      h('p', { id: 'death-how', class: 'death-how', text: `${n.headline}${n.when ? ` — ${n.when}` : ''}.` }),
      h('p', { class: 'death-role' }, 'You were the ', h('strong', { text: n.role }), '.'),
      h('p', { class: 'death-after', text: n.after }),
      button,
    ),
  );
  el.onkeydown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'Tab') {
      e.preventDefault(); // one button: keep focus inside the dialog
      button.focus();
    }
  };
}
