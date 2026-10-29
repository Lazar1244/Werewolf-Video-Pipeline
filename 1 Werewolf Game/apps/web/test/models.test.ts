// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { modelOption, priceTag, renderLobby, type LobbyData, type LobbyHandlers } from '../src/views/lobby';

/** Choosing the models for a game: the ready-made groups, the free pick, and the prices. */
const MODELS = [
  { alias: 'cheap', label: 'Cheap Model', enabled: true, inPerM: 0.1, outPerM: 0.3 },
  { alias: 'mid', label: 'Mid Model', enabled: true, inPerM: 1.5, outPerM: 7.5 },
  { alias: 'top', label: 'Top Model', enabled: true, inPerM: 10, outPerM: 50 },
  { alias: 'unknown', label: 'Mystery Model', enabled: true, inPerM: null, outPerM: null },
  { alias: 'off', label: 'Parked Model', enabled: false, inPerM: 0.2, outPerM: 0.6 },
];

const data = (): LobbyData => ({
  id: null,
  draft: null,
  compositions: [{ id: 'classic-7', label: 'Classic 7', category: 'classic', seats: 7, cards: ['werewolf'], description: 'd', tags: ['beginner'], weight: 4, band: { min: -3, max: 5 } }],
  models: MODELS,
  rosters: { 'quick-test': ['cheap', 'mid'] },
  links: null,
  estimate: null,
  connectedSlots: [],
  recent: [],
  busy: false,
  error: null,
});

function mount(created: [string, string[]][]) {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const hnd: LobbyHandlers = {
    create: (id, aliases) => created.push([id, aliases]),
    patch: () => undefined,
    links: () => undefined,
    estimate: () => undefined,
    start: () => undefined,
    spectatorLink: () => undefined,
    discard: () => undefined,
    replaceLink: () => undefined,
  };
  renderLobby(root, data(), hnd);
  return root;
}

const createButton = (root: HTMLElement) => [...root.querySelectorAll('button')].find((b) => b.textContent === 'Create the lobby') as HTMLButtonElement;

describe('prices next to model names', () => {
  it('reads as input and output per million tokens, or says it is unknown', () => {
    expect(priceTag(MODELS[0]!)).toBe('in $0.10 · out $0.30 per 1M tokens');
    expect(priceTag({ inPerM: 0.09999999999999999, outPerM: 0.04 })).toBe('in $0.10 · out $0.040 per 1M tokens');
    expect(priceTag(MODELS[2]!)).toBe('in $10 · out $50 per 1M tokens');
    expect(priceTag(MODELS[3]!)).toBe('price unknown');
    expect(modelOption(MODELS[1]!)).toBe('Mid Model — $1.50 in / $7.50 out per 1M');
    expect(modelOption(MODELS[3]!)).toBe('Mystery Model');
  });

  it('each ready-made group shows the range of its output prices', () => {
    const root = mount([]);
    const option = [...root.querySelectorAll('.create-bar option')].find((o) => o.textContent!.startsWith('quick-test'))!;
    expect(option.textContent).toBe('quick-test (2 models, output $0.30–$7.50 per 1M)');
  });
});

describe('the free pick', () => {
  it('lists every enabled model, cheapest first, each with its price', () => {
    const root = mount([]);
    const rows = [...root.querySelectorAll('.model-row')].map((r) => [r.querySelector('.model-name')!.textContent, r.querySelector('.model-price')!.textContent]);
    expect(rows.map((r) => r[0])).toEqual(['Cheap Model', 'Mid Model', 'Top Model', 'Mystery Model']); // the parked model is not offered
    expect(rows[2]![1]).toBe('in $10 · out $50 per 1M tokens');
  });

  it('is hidden until chosen, then creates the lobby with exactly the ticked models', () => {
    const created: [string, string[]][] = [];
    const root = mount(created);
    const panel = root.querySelector<HTMLElement>('.free-pick')!;
    expect(panel.style.display).toBe('none');
    const select = root.querySelector<HTMLSelectElement>('.create-bar select')!;
    select.value = '__free__';
    select.dispatchEvent(new Event('change'));
    expect(panel.style.display).toBe('');

    // nothing ticked: no lobby, and the host is told why
    createButton(root).click();
    expect(created).toEqual([]);
    expect(panel.textContent).toContain('Tick at least one model');

    for (const row of root.querySelectorAll('.model-row')) {
      const name = row.querySelector('.model-name')!.textContent;
      if (name === 'Top Model' || name === 'Cheap Model') (row.querySelector('input') as HTMLInputElement).click();
    }
    expect(root.querySelector('.create-bar')!.textContent).toContain('2 chosen');
    createButton(root).click();
    expect(created).toEqual([['classic-7', ['cheap', 'top']]]);
  });

  it('a ready-made group still creates the lobby with its own models', () => {
    const created: [string, string[]][] = [];
    const root = mount(created);
    const select = root.querySelector<HTMLSelectElement>('.create-bar select')!;
    select.value = 'quick-test';
    select.dispatchEvent(new Event('change'));
    createButton(root).click();
    expect(created.at(-1)).toEqual(['classic-7', ['cheap', 'mid']]);
  });
});
