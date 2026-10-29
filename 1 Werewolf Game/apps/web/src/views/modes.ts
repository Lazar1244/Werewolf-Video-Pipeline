import { roleLabel } from '@ww/projector';
import { ROLES, type RoleId } from '@ww/shared/roles';
import { h, replace } from '../dom';

/**
 * Game modes (ruleset §12): the gallery the host picks a table from, and the summary of the
 * chosen mode in the lobby. Every mode shown has passed the §12.1 checks (the server loads only
 * valid ones); the balance meter shows the §12.2 weight against the recommended band.
 */
export interface GameMode {
  id: string;
  label: string;
  category: 'classic' | 'recommended' | 'custom';
  seats: number;
  cards: string[];
  description: string | null;
  tags: string[];
  weight: number;
  weightRange?: { min: number; max: number };
  band: { min: number; max: number };
}

const GROUPS: { category: GameMode['category']; title: string; hint: string }[] = [
  { category: 'classic', title: 'Classic tables', hint: 'The traditional setups: the best way to start.' },
  { category: 'recommended', title: 'Recommended modes', hint: 'Tables built around one idea — more clues, more bluffing, a third side, or plain chaos.' },
  { category: 'custom', title: 'Your modes', hint: 'Modes made on this server.' },
];

/** What the host has picked in the gallery; it outlives a re-render of the lobby. */
export const gallery: { seats: number | null; selected: string | null } = { seats: null, selected: null };

/**
 * The gallery: a seat-count filter, then the modes grouped as classic, recommended and custom.
 * It redraws itself on a click (the rest of the lobby is left alone).
 */
export function renderGallery(root: HTMLElement, modes: GameMode[], onPick: (mode: GameMode) => void = () => undefined): void {
  if (!gallery.selected || !modes.some((m) => m.id === gallery.selected)) gallery.selected = (modes.find((m) => m.id === 'classic-7') ?? modes[0])?.id ?? null;
  // a redraw must not throw a keyboard or screen-reader user back to the top of the page
  const redraw = () => {
    const focused = document.activeElement instanceof HTMLElement && root.contains(document.activeElement) ? document.activeElement.dataset['focusKey'] : undefined;
    renderGallery(root, modes, onPick);
    if (focused) root.querySelector<HTMLElement>(`[data-focus-key="${focused}"]`)?.focus();
  };
  const counts = [...new Set(modes.map((m) => m.seats))].sort((a, b) => a - b);
  const filter = h(
    'div',
    { class: 'options seat-filter', role: 'group', 'aria-label': 'Number of seats' },
    h('span', { class: 'hint', text: 'Players:' }),
    chipButton('any', gallery.seats === null, () => {
      gallery.seats = null;
      redraw();
    }),
    ...counts.map((n) =>
      chipButton(String(n), gallery.seats === n, () => {
        gallery.seats = n;
        const current = modes.find((m) => m.id === gallery.selected);
        // keep the choice consistent with the filter: pick the first mode of that size
        if (current?.seats !== n) gallery.selected = modes.filter((m) => m.seats === n).sort(byCategory)[0]?.id ?? gallery.selected;
        redraw();
      }),
    ),
  );
  const shown = modes.filter((m) => gallery.seats === null || m.seats === gallery.seats);
  const groups = GROUPS.map((g) => {
    const list = shown.filter((m) => m.category === g.category).sort((a, b) => a.seats - b.seats || a.label.localeCompare(b.label));
    if (!list.length) return null;
    return h(
      'div',
      { class: 'mode-group' },
      h('h3', { text: g.title }),
      h('p', { class: 'hint', text: g.hint }),
      h(
        'div',
        { class: 'mode-grid' },
        ...list.map((m) =>
          modeCard(m, m.id === gallery.selected, () => {
            gallery.selected = m.id;
            onPick(m);
            redraw();
          }),
        ),
      ),
    );
  });
  replace(root, filter, ...groups, shown.length ? null : h('p', { class: 'hint', text: 'No mode for that number of players yet.' }));
}

const byCategory = (a: GameMode, b: GameMode) => GROUPS.findIndex((g) => g.category === a.category) - GROUPS.findIndex((g) => g.category === b.category) || a.label.localeCompare(b.label);

function chipButton(text: string, selected: boolean, onclick: () => void): HTMLElement {
  return h('button', { class: `chip-button${selected ? ' selected' : ''}`, 'aria-pressed': String(selected), 'data-focus-key': `seats-${text}`, onclick }, text);
}

/** One mode as a card: name, size, story, cards and balance. The whole card is the button. */
function modeCard(m: GameMode, selected: boolean, onPick: () => void): HTMLElement {
  // the card is named by its title and described by its story and balance, so a screen reader
  // hears what a sighted host sees
  const ids = { title: `mode-${m.id}-title`, desc: `mode-${m.id}-desc`, balance: `mode-${m.id}-balance` };
  return h(
    'div',
    {
      class: `mode-card${selected ? ' selected' : ''}`,
      role: 'button',
      tabindex: 0,
      'aria-pressed': String(selected),
      'aria-labelledby': ids.title,
      'aria-describedby': `${m.description ? ids.desc : ''} ${ids.balance}`.trim(),
      'data-focus-key': `mode-${m.id}`,
      onclick: onPick,
      onkeydown: (e: Event) => {
        const key = (e as KeyboardEvent).key;
        if (key === 'Enter' || key === ' ') {
          e.preventDefault();
          onPick();
        }
      },
    },
    h('div', { class: 'mode-head' }, h('strong', { id: ids.title, text: m.label, 'aria-label': `${m.label}, ${m.seats} players` }), h('span', { class: 'chip', 'aria-hidden': 'true', text: `${m.seats} players` })),
    m.tags.length ? h('div', { class: 'mode-tags small dim', text: m.tags.join(' · ') }) : null,
    m.description ? h('p', { class: 'mode-desc', id: ids.desc, text: m.description }) : null,
    roleChips(m.cards),
    balanceMeter(m, ids.balance),
  );
}

/** The cards of a mode, counted and coloured by side: wolves, loners, village. */
export function roleChips(cards: readonly string[]): HTMLElement {
  const counts = new Map<string, number>();
  for (const c of cards) counts.set(c, (counts.get(c) ?? 0) + 1);
  const side = (id: string) => {
    const meta = ROLES[id as RoleId];
    if (!meta) return '';
    if (meta.category === 'werewolf') return ' wolf';
    if (meta.category === 'solo') return ' solo';
    return '';
  };
  // wolves first, then loners, then the village — the way a table is usually read out
  const order = (id: string) => (side(id) === ' wolf' ? 0 : side(id) === ' solo' ? 1 : 2);
  const list = [...counts].sort((a, b) => order(a[0]) - order(b[0]) || a[0].localeCompare(b[0]));
  return h(
    'div',
    { class: 'role-chips' },
    ...list.map(([id, n]) => {
      // the Two Sisters are one role on two cards: show them once
      const shown = id === 'two_sisters' ? 1 : n;
      return h('span', { class: `role-chip${side(id)}`, text: `${shown > 1 ? `${shown}× ` : ''}${roleLabel(id as RoleId)}` });
    }),
  );
}

/**
 * The §12.2 balance, as a bar: the recommended band shaded, the mode's weight marked. The
 * weights are starting estimates (§12.2), so the words say "leans", never "favours".
 */
export function balanceMeter(m: Pick<GameMode, 'weight' | 'weightRange' | 'band'>, id?: string): HTMLElement {
  const span = 14; // the bar shows −14 … +14
  const pos = (w: number) => `${Math.max(0, Math.min(100, ((w + span) / (2 * span)) * 100)).toFixed(1)}%`;
  const lo = m.weightRange?.min ?? m.weight;
  const hi = m.weightRange?.max ?? m.weight;
  const verdict = hi < m.band.min ? 'leans towards the wolves' : lo > m.band.max ? 'leans towards the village' : m.weightRange ? 'depends on the cards the Thief leaves out' : 'balanced';
  const signed = (w: number) => `${w > 0 ? '+' : ''}${w}`;
  const shown = m.weightRange ? `${signed(m.weightRange.min)} to ${signed(m.weightRange.max)}` : signed(m.weight);
  const bar = h(
    'div',
    { class: 'meter', role: 'img', 'aria-label': `Balance ${shown}: ${verdict}` },
    h('i', { class: 'band', style: `left:${pos(m.band.min)};width:calc(${pos(m.band.max)} - ${pos(m.band.min)})` }),
    m.weightRange
      ? h('i', { class: 'range', style: `left:${pos(lo)};width:calc(${pos(hi)} - ${pos(lo)})` })
      : h('i', { class: 'mark', style: `left:${pos(m.weight)}` }),
  );
  return h(
    'div',
    { class: 'balance' },
    h('div', { class: 'balance-label small dim' }, h('span', { 'aria-hidden': 'true', text: 'wolves' }), h('span', { ...(id ? { id } : {}), text: `balance ${shown} — ${verdict}` }), h('span', { 'aria-hidden': 'true', text: 'village' })),
    bar,
  );
}

/** The chosen mode in the lobby: what the host picked, with its story, cards and balance. */
export function modeSummary(m: GameMode | undefined, fallbackCards: readonly string[]): HTMLElement {
  if (!m) return h('div', {}, roleChips(fallbackCards));
  return h(
    'div',
    { class: 'mode-summary' },
    h('div', { class: 'mode-head' }, h('strong', { text: m.label }), h('span', { class: 'chip', text: `${m.seats} players` })),
    m.description ? h('p', { class: 'mode-desc', text: m.description }) : null,
    roleChips(m.cards),
    balanceMeter(m),
  );
}
