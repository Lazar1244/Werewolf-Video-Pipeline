// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { renderLobby, type Draft, type LobbyData, type LobbyHandlers } from '../src/views/lobby';

/** The host picks how many rounds of talk each day has (1 or 2) before the game starts. */
const draft = (over: Partial<Draft> = {}): Draft => ({
  compositionId: 'classic-5',
  costCapUsd: 2,
  slots: [1, 2, 3, 4, 5].map((slot) => ({ slot, controller: 'ai' as const, alias: 'cheap', humanName: null })),
  ...over,
});

const data = (d: Draft): LobbyData => ({
  id: 'lobby-1',
  draft: d,
  compositions: [{ id: 'classic-5', label: 'Classic 5', category: 'classic', seats: 5, cards: ['werewolf'], description: 'd', tags: [], weight: 0, band: { min: -3, max: 5 } }],
  models: [{ alias: 'cheap', label: 'Cheap Model', enabled: true, inPerM: 0.1, outPerM: 0.3 }],
  rosters: {},
  links: null,
  estimate: null,
  connectedSlots: [],
  recent: [],
  busy: false,
  error: null,
});

function mount(d: Draft, patches: Partial<Draft>[] = []) {
  const root = document.createElement('div');
  const hnd: LobbyHandlers = {
    create: () => undefined,
    patch: (p) => patches.push(typeof p === 'function' ? p(d) : p),
    links: () => undefined,
    estimate: () => undefined,
    start: () => undefined,
    spectatorLink: () => undefined,
    discard: () => undefined,
    replaceLink: () => undefined,
  };
  renderLobby(root, data(d), hnd);
  const section = [...root.querySelectorAll('section')].find((s) => s.textContent!.includes('Day discussion'))!;
  return { section, select: section.querySelector('select')! };
}

describe('the day discussion choice', () => {
  it('offers 1 or 2 rounds and starts on 2, the rules default', () => {
    const { select, section } = mount(draft());
    expect([...select.options].map((o) => [o.value, o.textContent])).toEqual([['1', '1 round'], ['2', '2 rounds']]);
    expect(select.value).toBe('2');
    expect(section.textContent).toContain('Everyone speaks twice');
  });

  it('shows the choice already saved on the lobby', () => {
    const { select, section } = mount(draft({ rulesOverride: { discussion_rounds: 1 } }));
    expect(select.value).toBe('1');
    expect(section.textContent).toContain('Everyone speaks once');
  });

  it('sends the choice to the server as a rule override, keeping any other override', () => {
    const patches: Partial<Draft>[] = [];
    const { select } = mount(draft({ rulesOverride: { day_vote_reveal: 'open' } }), patches);
    select.value = '1';
    select.dispatchEvent(new Event('change'));
    expect(patches).toEqual([{ rulesOverride: { day_vote_reveal: 'open', discussion_rounds: 1 } }]);
  });
});
