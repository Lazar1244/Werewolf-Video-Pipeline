// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { balanceMeter, gallery, modeSummary, renderGallery, roleChips, type GameMode } from '../src/views/modes';

/** The game-mode gallery, as the host uses it: filter, read, pick. */
const band = { min: -3, max: 5 };
const mode = (id: string, category: GameMode['category'], seats: number, cards: string[], extra: Partial<GameMode> = {}): GameMode => ({
  id,
  label: id,
  category,
  seats,
  cards,
  description: `${id} description`,
  tags: ['beginner'],
  weight: 2,
  band,
  ...extra,
});

const MODES: GameMode[] = [
  mode('classic-5', 'classic', 5, ['werewolf', 'seer', 'villager', 'villager', 'villager']),
  mode('classic-7', 'classic', 7, ['werewolf', 'werewolf', 'seer', 'witch', 'hunter', 'villager', 'villager']),
  mode('fox-hunt-5', 'recommended', 5, ['werewolf', 'fox', 'hunter', 'villager', 'villager']),
  mode('pied-piper-7', 'recommended', 7, ['werewolf', 'piper', 'seer', 'witch', 'villager', 'villager', 'villager']),
];

const mount = () => document.createElement('div');
const cards = (root: HTMLElement) => [...root.querySelectorAll('.mode-card')].map((c) => c.querySelector('strong')!.textContent);

describe('the game-mode gallery', () => {
  it('shows classic and recommended modes in their own groups, with the classic 7 picked first', () => {
    gallery.seats = null;
    gallery.selected = null;
    const root = mount();
    renderGallery(root, MODES);
    const groups = [...root.querySelectorAll('.mode-group h3')].map((x) => x.textContent);
    expect(groups).toEqual(['Classic tables', 'Recommended modes']);
    expect(root.querySelector('.mode-card.selected strong')!.textContent).toBe('classic-7');
  });

  it('filters by the number of players, and keeps the choice consistent with the filter', () => {
    gallery.seats = null;
    gallery.selected = 'classic-7';
    const root = mount();
    renderGallery(root, MODES);
    ([...root.querySelectorAll('.chip-button')].find((b) => b.textContent === '5') as HTMLElement).click();
    expect(cards(root)).toEqual(['classic-5', 'fox-hunt-5']);
    expect(gallery.selected).toBe('classic-5'); // a 7-player mode is not left chosen behind a 5 filter
    ([...root.querySelectorAll('.chip-button')].find((b) => b.textContent === 'any') as HTMLElement).click();
    expect(cards(root)).toHaveLength(4);
  });

  it('picks a mode with a click or the keyboard, and says so', () => {
    gallery.seats = null;
    gallery.selected = 'classic-7';
    const picked: string[] = [];
    const root = mount();
    renderGallery(root, MODES, (m) => picked.push(m.id));
    const piper = [...root.querySelectorAll('.mode-card')].find((c) => c.querySelector('strong')!.textContent === 'pied-piper-7') as HTMLElement;
    piper.click();
    expect(picked).toEqual(['pied-piper-7']);
    expect(root.querySelector('.mode-card.selected strong')!.textContent).toBe('pied-piper-7');
    const fox = [...root.querySelectorAll('.mode-card')].find((c) => c.querySelector('strong')!.textContent === 'fox-hunt-5') as HTMLElement;
    fox.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(gallery.selected).toBe('fox-hunt-5');
  });

  it('lists the cards counted and by side: wolves first, then loners, then the village', () => {
    const chips = roleChips(['villager', 'piper', 'werewolf', 'villager', 'seer', 'two_sisters', 'two_sisters']);
    const list = [...chips.querySelectorAll('.role-chip')].map((c) => [c.textContent, c.className]);
    expect(list[0]).toEqual(['Werewolf', 'role-chip wolf']);
    expect(list[1]).toEqual(['Piper', 'role-chip solo']);
    expect(list.map((x) => x[0])).toContain('2× Villager');
    expect(list.map((x) => x[0])).toContain('Two Sisters'); // one role on two cards, shown once
  });

  it('reads the balance in words: balanced, leaning, or depending on the Thief', () => {
    expect(balanceMeter({ weight: 2, band }).textContent).toContain('balanced');
    expect(balanceMeter({ weight: 9, band }).textContent).toContain('leans towards the village');
    expect(balanceMeter({ weight: -8, band }).textContent).toContain('leans towards the wolves');
    expect(balanceMeter({ weight: 4, weightRange: { min: -7, max: 13 }, band }).textContent).toContain('Thief');
  });

  it('the lobby shows the chosen mode with its story and cards', () => {
    const s = modeSummary(MODES[3], []);
    expect(s.textContent).toContain('pied-piper-7 description');
    expect(s.textContent).toContain('Piper');
    expect(s.textContent).toContain('7 players');
  });
});
