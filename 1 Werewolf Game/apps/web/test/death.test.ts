// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerMessage } from '@ww/client-sdk';
import { initialState, reduce, type AppState } from '../src/app';
import { deathNotice, renderDeath } from '../src/views/death';

/**
 * "You died" (owner request, 2026-09-24): when a player's own seat falls they are told so, big
 * and red, with how — as far as they are allowed to know — and what is left for them to do.
 */
const seats = [1, 2, 3, 4, 5].map((n) => ({ seat: n, name: ['Alba', 'Bram', 'Cora', 'Dario', 'Elin'][n - 1]! }));
const at = (phase: string, day: number, night: number) => ({ phase, day, night });
const START = [
  { vseq: 1, at: at('night', 0, 1), type: 'GAME_START', payload: { seats, composition: ['werewolf', 'seer', 'villager', 'hunter', 'witch'], extras: 0, rules: {} } },
  { vseq: 2, at: at('night', 0, 1), type: 'ROLE_ASSIGNED', payload: { seat: 3, role: 'seer', team: 'Village' }, private: true, seats: [3] },
  { vseq: 3, at: at('night', 0, 1), type: 'PHASE_START', payload: { phase: 'night' } },
];
const dies = (vseq: number, when: ReturnType<typeof at>, seat = 3) => ({ vseq, at: when, type: 'DEATHS', payload: { deaths: [{ seat, reveal: { role: seat === 3 ? 'seer' : 'villager' } }] } });

function hello(scope: 'seat' | 'spectator', entries: unknown[], extra: Record<string, unknown> = {}): ServerMessage {
  return {
    type: 'hello',
    scope,
    principal: scope === 'seat' ? { kind: 'seat', seat: 3, slot: 3, name: 'Cora' } : { kind: 'spectator' },
    gameId: 'g1',
    status: 'running',
    lockOpen: false,
    view: null,
    entries,
    lastVseq: entries.length,
    pending: null,
    ...extra,
  } as ServerMessage;
}
function stateFrom(...messages: ServerMessage[]): AppState {
  let s = initialState('g1');
  for (const m of messages) s = reduce(s, m).state;
  return s;
}

describe('what the notice says', () => {
  it('says nothing while the player lives, or to a device with no seat', () => {
    expect(deathNotice(stateFrom(hello('seat', START)))).toBeNull();
    expect(deathNotice(stateFrom(hello('spectator', [...START.filter((e) => e.type !== 'ROLE_ASSIGNED'), dies(4, at('dawn', 0, 1))])))).toBeNull();
  });

  it('a night death, before the game is open: found dead at dawn, not which power did it', () => {
    const n = deathNotice(stateFrom(hello('seat', [...START, dies(4, at('dawn', 0, 1))])))!;
    expect(n).toMatchObject({ seat: 3, headline: 'Found dead at dawn', when: 'Night 1', wolves: false, role: 'Seer', button: 'Keep watching' });
    expect(n.after).toContain('can no longer speak or vote');
  });

  it('once the game is open to them: killed by the werewolves, with claw marks', () => {
    const open = [...START, dies(4, at('dawn', 0, 1)), { vseq: 5, at: at('dawn', 0, 1), type: 'DEATH_CAUSES', payload: { deaths: [{ seat: 3, causes: ['attack'] }] } }];
    const s = stateFrom(hello('seat', [...START, dies(4, at('dawn', 0, 1))], { lockOpen: true }), hello('spectator', open, { lockOpen: true }));
    const n = deathNotice(s)!;
    expect(n).toMatchObject({ headline: 'Killed by the werewolves', when: 'Night 1', wolves: true });
    expect(n.after).toContain('every card and every secret thought');
  });

  it('two causes at once are both told', () => {
    const open = [...START, dies(4, at('dawn', 0, 1)), { vseq: 5, at: at('dawn', 0, 1), type: 'DEATH_CAUSES', payload: { deaths: [{ seat: 3, causes: ['attack', 'poison'] }] } }];
    const s = stateFrom(hello('seat', [...START, dies(4, at('dawn', 0, 1))], { lockOpen: true }), hello('spectator', open, { lockOpen: true }));
    expect(deathNotice(s)!.headline).toBe('Killed by the werewolves and poisoned by the Witch');
  });

  it('executed by the village, or shot by the Hunter (named) — both public, so told at once', () => {
    const vote = [...START, { vseq: 4, at: at('day', 1, 1), type: 'EXECUTION', payload: { seat: 3 } }, dies(5, at('day', 1, 1))];
    expect(deathNotice(stateFrom(hello('seat', vote)))).toMatchObject({ headline: 'Executed by the village', when: 'Day 1', wolves: false });
    const shot = [...START, { vseq: 4, at: at('day', 1, 1), type: 'HUNTER_SHOT', payload: { hunter: 4, target: 3 } }, dies(5, at('day', 1, 1))];
    expect(deathNotice(stateFrom(hello('seat', shot)))!.headline).toBe('Shot by the Hunter, Dario');
  });

  it('a last action still to take (a Hunter shot) is said, and the button leads to it', () => {
    const pendingReq = { clientRequestId: 'r1', kind: 'target', context: 'hunter_shot', legal: { targets: [1, 2], allowNone: false }, deadlineAt: null };
    const n = deathNotice(stateFrom(hello('seat', [...START, dies(4, at('dawn', 0, 1))], { pending: pendingReq })))!;
    expect(n.after).toContain('one last action');
    expect(n.button).toBe('Take my last action');
  });
});

describe('the overlay', () => {
  it('is a labelled alert dialog, and Escape or the button closes it', () => {
    const el = document.createElement('div');
    let closed = 0;
    renderDeath(el, { seat: 3, headline: 'Killed by the werewolves', when: 'Night 1', wolves: true, role: 'Seer', after: 'x', button: 'Keep watching' }, true, () => closed++);
    expect(el.getAttribute('role')).toBe('alertdialog');
    expect(el.querySelector('#death-title')!.textContent).toBe('You died');
    expect(el.querySelector('#death-how')!.textContent).toBe('Killed by the werewolves — Night 1.');
    expect(el.textContent).toContain('You were the Seer.');
    expect(el.querySelectorAll('.claws path')).toHaveLength(3);
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    el.querySelector('button')!.click();
    expect(closed).toBe(2);
  });
});

/* ---- on the real page (main.ts, with a fake socket) ---- */

class FakeSocket {
  static readonly OPEN = 1;
  static all: FakeSocket[] = [];
  readyState = 0;
  onopen: ((e: unknown) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  send(): void {}
  close(): void {
    this.readyState = 3;
  }
  deliver(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}
const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};
async function boot(): Promise<FakeSocket> {
  vi.resetModules();
  FakeSocket.all = [];
  document.body.innerHTML = '<div id="app"></div>';
  history.replaceState(null, '', '/?game=g1');
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'host authentication required' }), { status: 401 })));
  await import('../src/main');
  await settle();
  const ws = FakeSocket.all.at(-1)!;
  ws.open();
  await settle();
  return ws;
}
const overlay = () => document.querySelector('.death-overlay');

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    // no storage
  }
});
afterEach(() => vi.unstubAllGlobals());

describe('the page', () => {
  it('shows "You died" the moment the player falls, once: closing it is remembered across a reload', async () => {
    let ws = await boot();
    ws.deliver(hello('seat', START));
    await settle();
    expect(overlay()).toBeNull(); // alive: nothing
    ws.deliver({ type: 'entries', scope: 'seat', fromVseq: 3, entries: [dies(4, at('dawn', 0, 1))] });
    await settle();
    expect(overlay()!.textContent).toContain('You died');
    expect(document.activeElement).toBe(overlay()!.querySelector('button'));
    expect(document.title).toBe('You died — Werewolf');

    overlay()!.querySelector('button')!.click();
    await settle();
    expect(overlay()).toBeNull();

    ws = await boot(); // a reload
    ws.deliver(hello('seat', [...START, dies(4, at('dawn', 0, 1))]));
    await settle();
    expect(overlay()).toBeNull();
  });

  it('someone else dying brings up nothing', async () => {
    const ws = await boot();
    ws.deliver(hello('seat', [...START, dies(4, at('dawn', 0, 1), 2)]));
    await settle();
    expect(overlay()).toBeNull();
  });
});
