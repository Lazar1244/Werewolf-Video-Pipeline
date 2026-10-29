import { roleLabel } from '@ww/projector';
import { assignProblem, assignRole, manualDealFrom, manualDealProblem, type Deal } from '@ww/shared/deal';
import { ROLES, type RoleId } from '@ww/shared/roles';
import { h, preserveEdits, replace } from '../dom';
import { gallery, modeSummary, renderGallery, type GameMode } from './modes';

/**
 * The host's lobby: pick a table, decide which seats are people, hand out the links, start.
 * Everyone else sees a waiting room until the host starts the game.
 */
export interface LobbyData {
  id: string | null;
  draft: Draft | null;
  compositions: GameMode[];
  models: ModelChoice[];
  rosters: Record<string, string[]>;
  links: { seats: { slot: number; humanName: string; url: string }[]; spectator: string; joined?: number[] } | null;
  estimate: { calls: [number, number]; usd: [number, number]; basis?: 'history' | 'prices' | 'mixed' } | null;
  connectedSlots: number[];
  /** Seats whose link was sent but not opened yet (so re-making links can be confirmed). */
  openLinks?: number[];
  /** A shareable spectator link, once the host has asked for one. */
  spectatorUrl?: string | null;
  /** Games already on this server, so the host can walk back into one. */
  recent: { id: string; status: string; winner: string | null; lockOpen: boolean; createdAt?: string; composition?: string | null }[];
  busy: boolean;
  error: string | null;
}

export interface Draft {
  compositionId: string;
  costCapUsd: number;
  slots: { slot: number; controller: 'ai' | 'human' | 'bot'; alias: string | null; humanName: string | null }[];
  seed?: string;
  /** Rule changes for this game only (validated by the server against the rules schema). */
  rulesOverride?: Record<string, unknown>;
  /** A custom game: the host's own seats and cards (null or absent: dealt at random). */
  manualDeal?: Deal | null;
}

/**
 * A change to the draft: the fields themselves, or a function of the latest draft. The function
 * form is applied when the change is sent, after any change still on its way, so two quick edits
 * (two role swaps, two seats) never undo each other.
 */
export type DraftPatch = Partial<Draft> | ((latest: Draft) => Partial<Draft>);

export interface LobbyHandlers {
  /**
   * Create the lobby for a mode, with the models its seats are filled from (in turn). `manual`: a
   * custom game, where the host seats the players and deals the cards.
   */
  create: (compositionId: string, aliases: string[], manual: boolean) => void;
  patch: (patch: DraftPatch) => void;
  links: () => void;
  estimate: () => void;
  start: (force: boolean) => void;
  spectatorLink: () => void;
  discard: () => void;
  /** Replace one player's link (the device that joined with the old one is shut out). */
  replaceLink: (slot: number) => void;
}

/** Rebuilds keep what the host is typing (a player connecting must not wipe a half-typed name). */
export function renderLobby(root: HTMLElement, d: LobbyData, hnd: LobbyHandlers): void {
  preserveEdits(root, () => buildLobby(root, d, hnd));
}

function buildLobby(root: HTMLElement, d: LobbyData, hnd: LobbyHandlers): void {
  const nodes: (HTMLElement | null)[] = [h('h1', { text: 'Werewolf' })];
  if (d.error) nodes.push(h('div', { class: 'banner danger', text: d.error }));

  if (!d.draft) {
    // 1. the game mode, from the gallery; 2. the models (a ready-made group, or a free pick);
    // 3. create the lobby
    const enabledModels = d.models.filter((m) => m.enabled);
    if (!modelPick.group) modelPick.group = 'quick-test' in d.rosters ? 'quick-test' : (Object.keys(d.rosters)[0] ?? FREE_PICK);
    const rosters = h(
      'select',
      { 'aria-label': 'Models' },
      ...Object.keys(d.rosters).map((r) => h('option', { value: r, ...(r === modelPick.group ? { selected: 'selected' } : {}) }, `${r} (${d.rosters[r]!.length} models${groupPrice(d, d.rosters[r]!)})`)),
      h('option', { value: FREE_PICK, ...(modelPick.group === FREE_PICK ? { selected: 'selected' } : {}) }, `Free pick — choose from all ${enabledModels.length} models`),
    );
    const freePick = freePickPanel(enabledModels);
    const showGroup = () => {
      modelPick.group = rosters.value;
      freePick.root.style.display = rosters.value === FREE_PICK ? '' : 'none';
      freePick.refresh();
    };
    rosters.addEventListener('change', () => {
      showGroup();
      // the list sits under the gallery: bring it to the host who just asked for it
      if (rosters.value === FREE_PICK) freePick.root.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    });
    showGroup();
    const chosenAliases = (): string[] => (rosters.value === FREE_PICK ? enabledModels.map((m) => m.alias).filter((a) => modelPick.chosen.has(a)) : (d.rosters[rosters.value] ?? []));
    const chosenLabel = h('strong', {});
    const showChoice = () => {
      const m = d.compositions.find((c) => c.id === gallery.selected);
      chosenLabel.textContent = m ? `${m.label} (${m.seats} players)` : 'no mode chosen';
    };
    const galleryRoot = h('div', { class: 'gallery' });
    renderGallery(galleryRoot, d.compositions, showChoice);
    showChoice();
    // The create bar follows the gallery and sticks to the bottom of the screen, so after picking a
    // card anywhere on a long page (on a phone, several screens down) it is right there.
    const createBar = h(
      'div',
      { class: 'create-bar', role: 'region', 'aria-label': 'Create the lobby' },
      h('div', { class: 'row' }, h('span', { class: 'hint', text: 'Mode:' }), chosenLabel),
      h(
        'div',
        { class: 'row' },
        h('label', { text: 'Models' }),
        rosters,
        freePick.count,
        h(
          'button',
          {
            class: 'primary',
            onclick: () => {
              const aliases = chosenAliases();
              if (!gallery.selected) return;
              if (!aliases.length) {
                freePick.warn('Tick at least one model.');
                return;
              }
              hnd.create(gallery.selected, aliases, customPick.on);
            },
          },
          'Create the lobby',
        ),
      ),
      h(
        'label',
        { class: 'row small' },
        h('input', {
          type: 'checkbox',
          ...(customPick.on ? { checked: 'checked' } : {}),
          onchange: (e: Event) => {
            customPick.on = (e.target as HTMLInputElement).checked;
          },
        }),
        h('span', { text: 'Custom game: I choose who sits at each seat and which role they get (nothing is dealt at random)' }),
      ),
    );
    nodes.push(
      h(
        'section',
        { class: 'panel gallery-panel' },
        h('h2', { text: 'Choose a game mode' }),
        h('div', { class: 'body' }, galleryRoot, freePick.root, h('p', { class: 'hint mt', text: 'You can still change who plays each seat before you start.' })),
        createBar,
      ),
    );
    if (d.recent.length) {
      nodes.push(
        section(
          'Games on this server',
          ...d.recent.slice(0, 12).map((g) =>
            h(
              'div',
              { class: 'row game-row' },
              h('a', { href: `/?game=${g.id}` }, g.composition ?? 'Game'),
              g.createdAt ? h('span', { class: 'small dim', text: when(g.createdAt) }) : null,
              h('span', { class: 'chip', text: STATUS[g.status] ?? g.status }),
              g.winner ? h('span', { class: 'chip', text: `${g.winner} won` }) : null,
              h('span', { class: 'small dim', text: g.id.slice(0, 8) }),
            ),
          ),
        ),
      );
    }
    replace(root, ...nodes.filter(Boolean));
    return;
  }

  const draft = d.draft;
  const enabled = d.models.filter((m) => m.enabled);
  const mode = d.compositions.find((c) => c.id === draft.compositionId);
  const deal = draft.manualDeal ?? null;
  const dealProblem = deal && mode ? manualDealProblem(mode.cards, mode.seats, deal) : null;
  nodes.push(h('div', { class: 'row' }, h('a', { href: '/', onclick: () => forgetGame() }, '← All games')));
  nodes.push(
    section(
      'Seats',
      mode ? dealChoice(hnd, mode, deal) : null,
      ...draft.slots.map((s) => {
        const controller = h(
          'select',
          { onchange: (e: Event) => setController(hnd, draft, s.slot, (e.target as HTMLSelectElement).value as 'ai' | 'human' | 'bot', enabled[0]?.alias ?? null) },
          h('option', { value: 'ai', ...(s.controller === 'ai' ? { selected: 'selected' } : {}) }, 'AI model'),
          h('option', { value: 'human', ...(s.controller === 'human' ? { selected: 'selected' } : {}) }, 'Person'),
          h('option', { value: 'bot', ...(s.controller === 'bot' ? { selected: 'selected' } : {}) }, 'Simple bot'),
        );
        const right =
          s.controller === 'ai'
            ? h(
                'select',
                { onchange: (e: Event) => setSlot(hnd, draft, s.slot, { alias: (e.target as HTMLSelectElement).value }) },
                ...enabled.map((m) => h('option', { value: m.alias, ...(s.alias === m.alias ? { selected: 'selected' } : {}) }, modelOption(m))),
              )
            : s.controller === 'human'
              ? nameInput(`name-${s.slot}`, s.humanName ?? `Player ${s.slot}`, (value) => setSlot(hnd, draft, s.slot, { humanName: value }))
              : h('span', { class: 'hint', text: 'plays at random' });
        return h(
          'div',
          { class: deal ? 'slot-row deal' : 'slot-row' },
          // a custom game seats slot n at seat n; otherwise the seats are drawn at the start
          h('span', { class: 'dim', text: deal ? `Seat ${s.slot}` : String(s.slot) }),
          controller,
          right,
          deal && mode ? roleSelect(hnd, mode, deal, s.slot - 1, `Role of seat ${s.slot}`) : null,
          h(
            'span',
            { class: 'small dim' },
            s.controller === 'human' ? (d.connectedSlots.includes(s.slot) ? 'connected ' : d.links?.joined?.includes(s.slot) ? 'joined ' : 'not here yet ') : '',
            // a joined player keeps their seat; to move them to another device, replace their link
            s.controller === 'human' && (d.links?.joined?.includes(s.slot) || d.connectedSlots.includes(s.slot))
              ? h('button', { class: 'ghost small', onclick: () => confirmReplace(hnd, s.slot, s.humanName ?? `seat ${s.slot}`) }, 'Replace link')
              : null,
          ),
        );
      }),
      deal && mode && deal.extras?.length
        ? h(
            'div',
            { class: 'slot-row deal' },
            h('span', { class: 'dim', text: 'Middle' }),
            h('span', { class: 'hint', text: 'the Thief’s two cards' }),
            ...deal.extras.map((_, k) => roleSelect(hnd, mode, deal, deal.roles.length + k, `Thief’s card ${k + 1}`)),
          )
        : null,
      deal ? h('p', { class: 'hint mt', text: 'Choosing a role swaps it with the seat that had it, so every card of the mode is always dealt exactly once. Each player sees only their own role; you, as host, see them all here.' }) : null,
      dealProblem ? h('div', { class: 'banner danger mt', text: `These cards do not fit the mode: ${dealProblem}. To start the deal again, switch “Seats and roles” to random and back.` }) : null,
      h('div', { class: 'mt' }, modeSummary(mode, [])),
    ),
  );

  const rounds = Number(draft.rulesOverride?.discussion_rounds ?? 2) === 1 ? 1 : 2;
  nodes.push(
    section(
      'Day discussion',
      h(
        'div',
        { class: 'row' },
        h('label', { text: 'Rounds of talk each day' }),
        h(
          'select',
          {
            onchange: (e: Event) => hnd.patch({ rulesOverride: { ...draft.rulesOverride, discussion_rounds: Number((e.target as HTMLSelectElement).value) } }),
          },
          h('option', { value: '1', text: '1 round', ...(rounds === 1 ? { selected: 'selected' } : {}) }),
          h('option', { value: '2', text: '2 rounds', ...(rounds === 2 ? { selected: 'selected' } : {}) }),
        ),
      ),
      h('p', {
        class: 'hint mt',
        text:
          rounds === 1
            ? 'Everyone speaks once before the vote: a shorter, cheaper day.'
            : 'Everyone speaks twice before the vote, so players can answer each other.',
      }),
    ),
  );

  nodes.push(
    section(
      'Cost',
      h(
        'div',
        { class: 'row' },
        h('label', { text: 'Cap for this game ($)' }),
        h('input', {
          type: 'number',
          min: '0.1',
          step: '0.5',
          'data-k': 'cap',
          value: String(draft.costCapUsd),
          onchange: (e: Event) => hnd.patch({ costCapUsd: Number((e.target as HTMLInputElement).value) }),
        }),
        h('button', { onclick: () => hnd.estimate() }, 'Estimate'),
      ),
      d.estimate
        ? h('p', {
            class: 'hint mt',
            text: `About ${d.estimate.calls[0]}–${d.estimate.calls[1]} model calls, roughly $${d.estimate.usd[0].toFixed(2)}–$${d.estimate.usd[1].toFixed(2)}. ${
              d.estimate.basis === 'history'
                ? 'Based on what these models really cost in earlier games.'
                : d.estimate.basis === 'mixed'
                  ? 'Partly from earlier games; the models not played yet are priced from their list price, which runs high.'
                  : 'From list prices, which run high: a real game usually costs much less.'
            }`,
          })
        : h('p', { class: 'hint mt', text: 'The game pauses at the cap; you can raise it and carry on.' }),
    ),
  );

  const humans = draft.slots.filter((s) => s.controller === 'human');
  if (humans.length) {
    nodes.push(
      section(
        'Links for the people playing',
        h('div', { class: 'row' }, h('button', { onclick: () => confirmLinks(hnd, d) }, d.links || d.openLinks?.length ? 'New links' : 'Create the links')),
        !d.links && d.openLinks?.length
          ? h('p', { class: 'hint', text: `Links were already made for ${d.openLinks.map((n) => humans.find((x) => x.slot === n)?.humanName ?? `seat ${n}`).join(', ')} and have not been opened yet.` })
          : null,
        d.links
          ? h(
              'div',
              { class: 'links mt' },
              // only the links of seats that are still people's
              ...d.links.seats
                .filter((l) => humans.some((x) => x.slot === l.slot))
                .map((s) => h('div', {}, h('strong', { text: s.humanName }), h('code', { text: s.url }))),
              d.links.joined?.length
                ? h('p', { class: 'hint', text: `Already joined, so no new link: ${d.links.joined.map((n) => humans.find((x) => x.slot === n)?.humanName ?? `seat ${n}`).join(', ')}. Use "Replace link" next to a name to move that player to another device.` })
                : null,
              h('p', { class: 'hint', text: 'Each link works once. Send each person their own — everything they see is private to them. When they open it, they get a private rejoin code on their own screen: if they ever lose their device, they give you that code and you make them a new link.' }),
            )
          : null,
      ),
    );
  }

  // Watching is separate from playing: a spectator link can be shared with anyone, opened any
  // number of times, and asking for one never touches the players' links.
  nodes.push(
    section(
      'People who only watch',
      h('div', { class: 'row' }, h('button', { onclick: () => hnd.spectatorLink() }, d.spectatorUrl ? 'Another spectator link' : 'Create a spectator link')),
      d.spectatorUrl ? h('div', { class: 'links mt' }, h('code', { text: d.spectatorUrl })) : null,
      h('p', { class: 'hint', text: 'Share it with as many people as you like. While a person can still act, it shows only what everyone at the table knows.' }),
    ),
  );

  const missing = humans.filter((s) => !d.connectedSlots.includes(s.slot));
  nodes.push(
    section(
      'Start',
      h(
        'div',
        { class: 'row' },
        h('button', { class: 'primary', ...(d.busy || dealProblem ? { disabled: true } : {}), onclick: () => hnd.start(false) }, 'Start the game'),
        missing.length ? h('button', { ...(d.busy || dealProblem ? { disabled: true } : {}), onclick: () => hnd.start(true) }, `Start without ${missing.length} missing player${missing.length > 1 ? 's' : ''}`) : null,
      ),
      missing.length ? h('p', { class: 'hint mt', text: `Waiting for: ${missing.map((s) => s.humanName ?? `seat ${s.slot}`).join(', ')}. ${missing.length > 1 ? `Starting without them gives their seats to ${forcedModel(d)}${deal ? ', each keeping the role you gave that seat' : ''}` : `Starting without them gives the seat to ${forcedModel(d)}${deal ? ', keeping the role you gave it' : ''}`}.` }) : null,
      h('div', { class: 'row mt' }, h('button', { class: 'ghost', onclick: () => confirmDiscard(hnd) }, 'Discard this lobby')),
    ),
  );
  replace(root, ...nodes.filter(Boolean));
}

/**
 * What the people who are not the host see before the game starts — and the three dead ends:
 * no game at all, a game this device was turned away from, and simply waiting.
 */
export function renderWaitingRoom(
  root: HTMLElement,
  slot: number | null,
  connected: number[],
  status: { refused: string | null; waiting: boolean; rejoinCode?: string | null; hostLogin?: (token: string) => void; error?: string | null } = { refused: null, waiting: true },
): void {
  if (status.refused) {
    replace(
      root,
      h('h1', { text: 'Werewolf' }),
      section(
        'You cannot join this game',
        h('p', { text: status.refused }),
        h('p', { class: 'hint', text: 'Ask the host for your own join link, or for a new one with your rejoin code. Opening someone else’s link will not work.' }),
        h('div', { class: 'row mt' }, h('button', { onclick: () => location.assign('/') }, 'Start again')),
      ),
    );
    return;
  }
  if (!status.waiting) {
    replace(
      root,
      h('h1', { text: 'Werewolf' }),
      section(
        'Nothing to join yet',
        h('p', { text: 'This page needs a join link. The host of the game sends you one — it works once and then this device is remembered.' }),
        h('p', { class: 'hint', text: 'If you were playing and got logged out, ask the host to reissue your link with your rejoin code.' }),
      ),
      status.hostLogin ? hostLoginSection(status.hostLogin, status.error ?? null) : null,
    );
    return;
  }
  replace(
    root,
    h('h1', { text: 'Werewolf' }),
    section(
      'Waiting for the host',
      h('p', { text: slot === null ? 'You are here as a spectator. The game will appear as soon as it starts.' : `You are seated (slot ${slot}). The game starts when everyone is here.` }),
      h('p', { class: 'hint', text: `${connected.length} player${connected.length === 1 ? '' : 's'} connected so far.` }),
      status.rejoinCode
        ? h(
            'p',
            { class: 'hint rejoin' },
            'Your private rejoin code: ',
            h('strong', { text: status.rejoinCode }),
            '. Write it down. If you ever lose this device, give it to the host so they can make you a new link. Nobody else can see it.',
          )
        : null,
    ),
  );
}

/** A model the host can seat, with what it costs (dollars per million tokens), when known. */
export interface ModelChoice {
  alias: string;
  label: string;
  enabled: boolean;
  inPerM?: number | null;
  outPerM?: number | null;
}

const FREE_PICK = '__free__';

/** The host's "custom game" tick on the new-game screen; it outlives a re-render. */
const customPick: { on: boolean } = { on: false };

/** Seats and roles: dealt at random, or the host's own (a custom game). */
function dealChoice(hnd: LobbyHandlers, mode: GameMode, deal: Deal | null): HTMLElement {
  const choice = h(
    'select',
    {
      'aria-label': 'Seats and roles',
      onchange: (e: Event) => hnd.patch({ manualDeal: (e.target as HTMLSelectElement).value === 'manual' ? manualDealFrom(mode.cards, mode.seats) : null }),
    },
    h('option', { value: 'random', ...(deal ? {} : { selected: 'selected' }) }, 'Dealt at random when the game starts'),
    h('option', { value: 'manual', ...(deal ? { selected: 'selected' } : {}) }, 'Custom: I choose each seat’s player and role'),
  );
  choice.value = deal ? 'manual' : 'random'; // the chosen option, also where `selected` is read only on insertion
  return h('div', { class: 'row' }, h('label', { text: 'Seats and roles' }), choice);
}

/**
 * One place's role (a seat, or one of the Thief's middle cards): any of the mode's roles, wolves
 * first. A role that would make the deal unplayable (the Thief in the middle, the last pack wolf
 * set aside) is greyed out with the reason.
 */
function roleSelect(hnd: LobbyHandlers, mode: GameMode, deal: Deal, pos: number, label: string): HTMLElement {
  const current = [...deal.roles, ...(deal.extras ?? [])][pos];
  const side = (r: RoleId) => (ROLES[r]?.category === 'werewolf' ? 0 : ROLES[r]?.category === 'solo' ? 1 : 2);
  const kinds = [...new Set(mode.cards as RoleId[])].sort((a, b) => side(a) - side(b) || roleLabel(a).localeCompare(roleLabel(b)));
  const tone = current === undefined ? '' : side(current) === 0 ? ' wolf' : side(current) === 1 ? ' solo' : '';
  const pick = h(
    'select',
    {
      'aria-label': label,
      class: `role-pick${tone}`,
      // swapped on the latest deal when the change is sent, so quick changes all count
      onchange: (e: Event) => {
        const role = (e.target as HTMLSelectElement).value as RoleId;
        // a change still on its way when the host switched to a random deal is dropped, not revived
        hnd.patch((latest) => (latest.manualDeal ? { manualDeal: assignRole(latest.manualDeal, pos, role) } : {}));
      },
    },
    ...kinds.map((r) => {
      const why = r === current ? null : assignProblem(mode.cards, mode.seats, deal, pos, r);
      return h('option', { value: r, ...(r === current ? { selected: 'selected' } : {}), ...(why ? { disabled: 'disabled', title: `Not possible: ${why}` } : {}) }, why ? `${roleLabel(r)} (not possible here)` : roleLabel(r));
    }),
  );
  if (current) pick.value = current;
  return pick;
}

/** The host's model choice on the new-game screen; it outlives a re-render of the lobby. */
const modelPick: { group: string | null; chosen: Set<string> } = { group: null, chosen: new Set() };

/** $0.040, $0.15, $2.50, $50 — prices per 1M tokens (a catalogue 0.1 arrives as 0.0999…, so round first). */
const money = (raw: number): string => {
  const n = Math.round(raw * 10_000) / 10_000;
  return n === 0 ? '$0' : n < 0.1 ? `$${n.toFixed(3)}` : n < 10 ? `$${n.toFixed(2)}` : `$${n.toFixed(0)}`;
};

/** "in $0.15 · out $0.60 per 1M" — what a host reads next to a model's name. */
export function priceTag(m: Pick<ModelChoice, 'inPerM' | 'outPerM'>): string {
  if (m.inPerM == null || m.outPerM == null) return 'price unknown';
  return `in ${money(m.inPerM)} · out ${money(m.outPerM)} per 1M tokens`;
}

/** A model in a dropdown: its name, then its price per million input and output tokens. */
export function modelOption(m: ModelChoice): string {
  return m.inPerM == null || m.outPerM == null ? m.label : `${m.label} — ${money(m.inPerM)} in / ${money(m.outPerM)} out per 1M`;
}

/** The price range of a ready-made group, for its line in the list. */
function groupPrice(d: LobbyData, aliases: string[]): string {
  const outs = aliases.map((a) => d.models.find((m) => m.alias === a)?.outPerM).filter((x): x is number => typeof x === 'number');
  if (!outs.length) return '';
  const lo = Math.min(...outs);
  const hi = Math.max(...outs);
  return `, output ${money(lo)}${hi !== lo ? `–${money(hi)}` : ''} per 1M`;
}

/**
 * The free pick: every enabled model, cheapest first, with its price per million input and
 * output tokens. The ticked models fill the seats in turn (a model may take several seats).
 */
function freePickPanel(models: ModelChoice[]): { root: HTMLElement; count: HTMLElement; warn: (text: string) => void; refresh: () => void } {
  const byPrice = [...models].sort((a, b) => (a.outPerM ?? Infinity) - (b.outPerM ?? Infinity) || a.label.localeCompare(b.label));
  const count = h('span', { class: 'small dim' });
  const note = h('p', { class: 'hint', 'aria-live': 'polite' });
  const refresh = () => {
    count.textContent = modelPick.group === FREE_PICK ? `${modelPick.chosen.size} chosen` : '';
    note.textContent = '';
  };
  const boxes: HTMLInputElement[] = [];
  const rows = byPrice.map((m) => {
    const box = h('input', {
      type: 'checkbox',
      value: m.alias,
      ...(modelPick.chosen.has(m.alias) ? { checked: 'checked' } : {}),
      onchange: (e: Event) => {
        if ((e.target as HTMLInputElement).checked) modelPick.chosen.add(m.alias);
        else modelPick.chosen.delete(m.alias);
        refresh();
      },
    });
    boxes.push(box);
    return h('label', { class: 'model-row' }, box, h('span', { class: 'model-name', text: m.label }), h('span', { class: 'model-price small dim', text: priceTag(m) }));
  });
  const setAll = (on: boolean) => {
    for (const b of boxes) {
      b.checked = on;
      if (on) modelPick.chosen.add(b.value);
      else modelPick.chosen.delete(b.value);
    }
    refresh();
  };
  const root = h(
    'div',
    { class: 'free-pick mt' },
    h('h3', { text: 'Choose the models' }),
    h('p', {
      class: 'hint',
      text: 'Tick the models to play. They fill the seats in turn, so one model can take several seats. Prices are OpenRouter’s list prices per million tokens read (in) and written (out); some providers of the same model charge more, and the cost cap always allows for the highest.',
    }),
    h('div', { class: 'options' }, h('button', { class: 'ghost', onclick: () => setAll(true) }, 'Tick all'), h('button', { class: 'ghost', onclick: () => setAll(false) }, 'Untick all')),
    h('div', { class: 'model-list' }, ...rows),
    note,
  );
  refresh();
  return {
    root,
    count,
    refresh,
    warn: (text: string) => {
      note.textContent = text;
    },
  };
}

/** The host, on another device than the server, signs in once with HOST_TOKEN. */
function hostLoginSection(onLogin: (token: string) => void, error: string | null): HTMLElement {
  const input = h('input', { type: 'password', placeholder: 'host token', autocomplete: 'current-password', 'data-k': 'host-token', value: '' });
  const go = () => {
    if (input.value.trim()) onLogin(input.value.trim());
  };
  input.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') go();
  });
  return section(
    'Are you the host?',
    h('p', { class: 'hint', text: 'On the computer that runs the server you are the host automatically. From another device, enter the HOST_TOKEN from the .env file once.' }),
    h('div', { class: 'row' }, input, h('button', { onclick: go }, 'Sign in as host')),
    error ? h('div', { class: 'banner danger mt', text: error }) : null,
  );
}

/** Re-making links kills the ones already sent and not yet opened: never do that by surprise. */
function confirmLinks(hnd: LobbyHandlers, d: LobbyData): void {
  if (!d.links && !d.openLinks?.length) {
    hnd.links();
    return;
  }
  if (window.confirm('Make new links? Any link you already sent that has not been opened yet will stop working (players who already joined keep their seat).')) hnd.links();
}

function confirmReplace(hnd: LobbyHandlers, slot: number, who: string): void {
  if (window.confirm(`Make ${who} a new link? The device that joined with the old one is shut out.`)) hnd.replaceLink(slot);
}

function confirmDiscard(hnd: LobbyHandlers): void {
  if (window.confirm('Discard this lobby? Its links stop working. Nothing was played yet, so nothing is lost.')) hnd.discard();
}

const STATUS: Record<string, string> = { lobby: 'lobby', running: 'running', paused: 'paused', over_offer: 'over', debrief: 'debrief', over: 'over', aborted: 'aborted' };

const when = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
};

/** Leaving a lobby for the games list: this device should not reopen it on its own. */
function forgetGame(): void {
  try {
    localStorage.removeItem('ww.game');
  } catch {
    // nothing was remembered
  }
}

function section(title: string, ...children: (HTMLElement | null)[]): HTMLElement {
  const body = h('div', { class: 'body' });
  for (const c of children) if (c) body.appendChild(c);
  return h('section', { class: 'panel' }, h('h2', { text: title }), body);
}

function nameInput(key: string, value: string, onChange: (v: string) => void): HTMLElement {
  return h('input', { type: 'text', value, maxlength: 40, 'data-k': key, onchange: (e: Event) => onChange((e.target as HTMLInputElement).value.trim() || value) });
}

// Seat changes are applied to the latest draft when sent: setting up a table seat by seat in quick
// succession (a custom game) must not lose an earlier seat's change.
function setController(hnd: LobbyHandlers, _draft: Draft, slot: number, controller: 'ai' | 'human' | 'bot', defaultAlias: string | null): void {
  hnd.patch((latest) => ({
    slots: latest.slots.map((s) =>
      s.slot === slot
        ? { ...s, controller, alias: controller === 'ai' ? (s.alias ?? defaultAlias) : null, humanName: controller === 'human' ? (s.humanName ?? `Player ${slot}`) : null }
        : s,
    ),
  }));
}

function setSlot(hnd: LobbyHandlers, _draft: Draft, slot: number, patch: Partial<Draft['slots'][number]>): void {
  hnd.patch((latest) => ({ slots: latest.slots.map((s) => (s.slot === slot ? { ...s, ...patch } : s)) }));
}

/** Who takes a missing person's seat on a forced start: the lobby's first model (as the server does). */
function forcedModel(d: LobbyData): string {
  const alias = d.draft?.slots.find((s) => s.controller === 'ai')?.alias;
  const m = alias ? d.models.find((x) => x.alias === alias) : undefined;
  return m ? m.label : alias ?? 'a model';
}
