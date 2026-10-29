// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { renderLobby, type Draft, type DraftPatch, type LobbyData, type LobbyHandlers } from '../src/views/lobby';
import type { GameMode } from '../src/views/modes';

// A custom game (owner request, 2026-10-26): the host picks the mode, puts a model at each seat
// and gives each seat its role. The lobby shows the seats in order, each with a role picker.
const SEVEN = ['werewolf', 'werewolf', 'seer', 'witch', 'hunter', 'villager', 'villager'];
const THIEF9 = ['thief', 'werewolf', 'werewolf', 'seer', 'witch', 'hunter', 'cupid', 'little_girl', 'villager', 'villager', 'villager'];
const MODES: GameMode[] = [
  { id: 'classic-7', label: 'Classic 7', category: 'classic', seats: 7, cards: SEVEN, description: 'd', tags: [], weight: 0, band: { min: -3, max: 5 } },
  { id: 'thiefs-game-9', label: 'The Thief’s Game', category: 'recommended', seats: 9, cards: THIEF9, description: 'd', tags: [], weight: 0, band: { min: -3, max: 5 } },
];
const MODELS = [
  { alias: 'gpt', label: 'GPT', enabled: true, inPerM: 1, outPerM: 2 },
  { alias: 'qwen', label: 'Qwen', enabled: true, inPerM: 1, outPerM: 2 },
];

const draftOf = (compositionId: string, seats: number, manualDeal: Draft['manualDeal']): Draft => ({
  compositionId,
  costCapUsd: 2,
  slots: Array.from({ length: seats }, (_, i) => ({ slot: i + 1, controller: 'ai' as const, alias: i % 2 ? 'qwen' : 'gpt', humanName: null })),
  ...(manualDeal !== undefined ? { manualDeal } : {}),
});

const data = (draft: Draft | null): LobbyData => ({
  id: draft ? 'g1' : null,
  draft,
  compositions: MODES,
  models: MODELS,
  rosters: { 'quick-test': ['gpt', 'qwen'] },
  links: null,
  estimate: null,
  connectedSlots: [],
  recent: [],
  busy: false,
  error: null,
});

function mount(draft: Draft | null) {
  const created: [string, string[], boolean][] = [];
  const patches: Partial<Draft>[] = [];
  const root = document.createElement('div');
  document.body.appendChild(root);
  const hnd: LobbyHandlers = {
    create: (id, aliases, manual) => created.push([id, aliases, manual]),
    patch: (p) => patches.push(typeof p === 'function' ? p(draft!) : p), // a change from the latest draft: here, the rendered one
    links: () => undefined,
    estimate: () => undefined,
    start: () => undefined,
    spectatorLink: () => undefined,
    discard: () => undefined,
    replaceLink: () => undefined,
  };
  renderLobby(root, data(draft), hnd);
  return { root, created, patches };
}

const pick = (el: HTMLSelectElement, value: string) => {
  el.value = value;
  el.dispatchEvent(new Event('change'));
};

describe('creating a custom game', () => {
  it('the create bar offers it, and the lobby is created with the host’s own deal', () => {
    const { root, created } = mount(null);
    const box = [...root.querySelectorAll<HTMLInputElement>('.create-bar input[type=checkbox]')].find((b) => b.parentElement!.textContent!.includes('Custom game'))!;
    const create = [...root.querySelectorAll('button')].find((b) => b.textContent === 'Create the lobby')!;
    create.click();
    expect(created.at(-1)![2]).toBe(false); // unticked: the usual random deal
    box.click();
    create.click();
    expect(created.at(-1)![2]).toBe(true);
    box.click(); // leave the shared tick as it was for the other tests
  });
});

describe('the seats of a custom game', () => {
  it('shows each seat in order with its player and its role', () => {
    const { root } = mount(draftOf('classic-7', 7, { roles: ['villager', 'werewolf', 'seer', 'witch', 'hunter', 'werewolf', 'villager'] }));
    const rows = [...root.querySelectorAll('.slot-row.deal')];
    expect(rows.map((r) => r.firstElementChild!.textContent)).toEqual(['Seat 1', 'Seat 2', 'Seat 3', 'Seat 4', 'Seat 5', 'Seat 6', 'Seat 7']);
    const roles = [...root.querySelectorAll<HTMLSelectElement>('select.role-pick')];
    expect(roles.map((s) => s.value)).toEqual(['villager', 'werewolf', 'seer', 'witch', 'hunter', 'werewolf', 'villager']);
    // the mode's roles, wolves first; a wolf seat is marked as one
    expect([...roles[0]!.options].map((o) => o.value)[0]).toBe('werewolf');
    expect(roles[1]!.classList.contains('wolf')).toBe(true);
    expect(root.querySelector<HTMLSelectElement>('select[aria-label="Seats and roles"]')!.value).toBe('manual');
  });

  it('choosing a role swaps it with the seat that had it', () => {
    const { root, patches } = mount(draftOf('classic-7', 7, { roles: [...SEVEN] as never }));
    pick(root.querySelector<HTMLSelectElement>('select[aria-label="Role of seat 7"]')!, 'seer');
    expect(patches.at(-1)!.manualDeal!.roles).toEqual(['werewolf', 'werewolf', 'villager', 'witch', 'hunter', 'villager', 'seer']);
  });

  it('greys out a role that would make the deal unplayable, with the reason', () => {
    const roles = THIEF9.slice(0, 9);
    const { root } = mount(draftOf('thiefs-game-9', 9, { roles, extras: ['villager', 'villager'] } as never));
    const middle = root.querySelector<HTMLSelectElement>('select[aria-label="Thief’s card 1"]')!;
    const thief = [...middle.options].find((o) => o.value === 'thief')!;
    expect(thief.disabled).toBe(true);
    expect(thief.title).toMatch(/Thief must sit at a seat/);
    expect([...middle.options].find((o) => o.value === 'seer')!.disabled).toBe(false);
  });

  it('a role change is worked out on the latest deal, so two quick changes both count', () => {
    let latest = draftOf('classic-7', 7, { roles: [...SEVEN] as never });
    const sent: Partial<Draft>[] = [];
    const root = document.createElement('div');
    const hnd: LobbyHandlers = {
      create: () => undefined,
      // like the app: each change is applied to the draft the previous one left
      patch: (p) => {
        const body = typeof p === 'function' ? p(latest) : p;
        sent.push(body);
        latest = { ...latest, ...body };
      },
      links: () => undefined,
      estimate: () => undefined,
      start: () => undefined,
      spectatorLink: () => undefined,
      discard: () => undefined,
      replaceLink: () => undefined,
    };
    renderLobby(root, data(latest), hnd); // both changes are made on this one render, before any reply
    pick(root.querySelector<HTMLSelectElement>('select[aria-label="Role of seat 7"]')!, 'seer');
    pick(root.querySelector<HTMLSelectElement>('select[aria-label="Role of seat 6"]')!, 'hunter');
    expect(latest.manualDeal!.roles).toEqual(['werewolf', 'werewolf', 'villager', 'witch', 'villager', 'hunter', 'seer']);
  });

  it('a role change still on its way after a switch to random is dropped, not revived', () => {
    const rendered = draftOf('classic-7', 7, { roles: [...SEVEN] as never });
    const queued: DraftPatch[] = [];
    const root = document.createElement('div');
    const hnd: LobbyHandlers = {
      create: () => undefined,
      patch: (p) => queued.push(p), // kept as sent, to be applied to whatever the draft is by then
      links: () => undefined,
      estimate: () => undefined,
      start: () => undefined,
      spectatorLink: () => undefined,
      discard: () => undefined,
      replaceLink: () => undefined,
    };
    renderLobby(root, data(rendered), hnd);
    pick(root.querySelector<HTMLSelectElement>('select[aria-label="Role of seat 7"]')!, 'seer');
    const change = queued.at(-1) as (latest: Draft) => Partial<Draft>;
    expect(change(rendered).manualDeal!.roles[6]).toBe('seer'); // still custom: the swap applies
    expect(change(draftOf('classic-7', 7, null))).toEqual({}); // switched to random meanwhile: nothing comes back
  });

  it('a Thief mode shows the two middle cards, which swap like the seats', () => {
    const roles = THIEF9.slice(0, 9);
    const { root, patches } = mount(draftOf('thiefs-game-9', 9, { roles, extras: ['villager', 'villager'] } as never));
    const middle = [...root.querySelectorAll('.slot-row.deal')].find((r) => r.firstElementChild!.textContent === 'Middle')!;
    expect(middle.querySelectorAll('select')).toHaveLength(2);
    pick(root.querySelector<HTMLSelectElement>('select[aria-label="Thief’s card 1"]')!, 'cupid');
    expect(patches.at(-1)!.manualDeal!.extras).toEqual(['cupid', 'villager']);
  });

  it('switches between the host’s deal and a random one', () => {
    const custom = mount(draftOf('classic-7', 7, { roles: [...SEVEN] as never }));
    pick(custom.root.querySelector<HTMLSelectElement>('select[aria-label="Seats and roles"]')!, 'random');
    expect(custom.patches.at(-1)).toEqual({ manualDeal: null });
    const random = mount(draftOf('classic-7', 7, undefined));
    expect(random.root.querySelectorAll('select.role-pick')).toHaveLength(0);
    expect(random.root.querySelector('.slot-row')!.firstElementChild!.textContent).toBe('1'); // seats are drawn at the start
    pick(random.root.querySelector<HTMLSelectElement>('select[aria-label="Seats and roles"]')!, 'manual');
    expect(random.patches.at(-1)).toEqual({ manualDeal: { roles: SEVEN } });
  });

  it('will not start with cards that do not fit the mode', () => {
    const { root } = mount(draftOf('classic-7', 7, { roles: ['werewolf', 'werewolf', 'werewolf', 'witch', 'hunter', 'villager', 'villager'] } as never));
    expect(root.querySelector('.banner.danger')!.textContent).toContain('do not fit the mode');
    expect(root.querySelector('.banner.danger')!.textContent).toContain('switch “Seats and roles” to random and back');
    const start = [...root.querySelectorAll('button')].find((b) => b.textContent === 'Start the game') as HTMLButtonElement;
    expect(start.disabled).toBe(true);
  });
});
