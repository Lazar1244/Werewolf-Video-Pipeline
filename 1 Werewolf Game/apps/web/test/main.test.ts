// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerMessage } from '@ww/client-sdk';

/**
 * The real `main.ts`, wired to a fake socket and a fake server: what the page sends, and what it
 * shows, when the server says things. This is where the links button, Resume after a reload, the
 * offline banner and the host commands are tested as the host and players actually use them.
 */
class FakeSocket {
  static readonly OPEN = 1;
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: Record<string, unknown>[] = [];
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
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(code = 1000, reason = ''): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
  deliver(msg: ServerMessage): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}
let calls: Call[] = [];
const hostData: Record<string, unknown> = {
  '/api/compositions': { compositions: [{ id: 'classic-7', label: 'Classic 7', category: 'classic', seats: 7, cards: ['werewolf'], description: null, tags: [], weight: 0, band: { min: -3, max: 5 } }] },
  '/api/models': { profiles: [{ alias: 'glm-flash', label: 'GLM Flash', enabled: true }] },
  '/api/rosters': { rosters: { 'quick-test': ['glm-flash'] } },
  '/api/games': { games: [] },
};

function fakeFetch(asHost: boolean) {
  return vi.fn(async (url: string, init: RequestInit = {}) => {
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    calls.push({ url: path, method: init.method ?? 'GET', headers: (init.headers ?? {}) as Record<string, string>, body: init.body ? JSON.parse(String(init.body)) : undefined });
    if (path === '/api/host/login') return new Response(JSON.stringify({ error: 'that is not the host token' }), { status: 401 });
    if (!asHost) return new Response(JSON.stringify({ error: 'host authentication required' }), { status: 401 });
    if (hostData[path]) return new Response(JSON.stringify(hostData[path]), { status: 200 });
    if (/\/api\/lobbies\/[^/]+\/links$/.test(path)) {
      // the real server refuses an empty body sent as JSON: so does this one
      if ((init.headers as Record<string, string> | undefined)?.['Content-Type'] && !init.body) return new Response(JSON.stringify({ error: 'Bad Request', message: 'Body cannot be empty when content-type is set to application/json' }), { status: 400, statusText: 'Bad Request' });
      return new Response(JSON.stringify({ seats: [{ slot: 1, humanName: 'Nadia', url: 'http://192.168.1.5:3000/join/abc' }], spectator: 'http://192.168.1.5:3000/spectate/def' }), { status: 200 });
    }
    if (/\/api\/games\/[^/]+\/spectator-link$/.test(path)) return new Response(JSON.stringify({ url: 'http://192.168.1.5:3000/spectate/xyz' }), { status: 200 });
    if (/\/api\/lobbies\/[^/]+$/.test(path))
      return new Response(JSON.stringify({ draft: { compositionId: 'classic-7', costCapUsd: 2, slots: [1, 2, 3, 4, 5, 6, 7].map((n) => ({ slot: n, controller: n === 1 ? 'human' : 'ai', alias: n === 1 ? null : 'glm-flash', humanName: n === 1 ? 'Nadia' : null })) } }), { status: 200 });
    return new Response('{}', { status: 404 });
  });
}

const tick = () => new Promise((r) => setTimeout(r, 0));
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await tick();
}

async function boot(url: string, asHost: boolean): Promise<FakeSocket | null> {
  vi.resetModules();
  FakeSocket.all = [];
  calls = [];
  document.body.innerHTML = '<div id="app"></div>';
  history.replaceState(null, '', url);
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('fetch', fakeFetch(asHost));
  vi.stubGlobal('confirm', () => true);
  await import('../src/main');
  await settle();
  const ws = FakeSocket.all.at(-1) ?? null;
  ws?.open();
  await settle();
  return ws;
}

const text = () => document.getElementById('app')!.textContent ?? '';
const button = (label: string) => [...document.querySelectorAll('button')].find((b) => b.textContent === label) as HTMLButtonElement | undefined;

const seats = [1, 2, 3, 4, 5, 6, 7].map((n) => ({ seat: n, name: `P${n}` }));
const started = (scope: 'host' | 'seat', extra: Record<string, unknown> = {}): ServerMessage =>
  ({
    type: 'hello',
    scope,
    principal: scope === 'host' ? { kind: 'host' } : { kind: 'seat', seat: 3, slot: 1, name: 'P3' },
    gameId: 'g1',
    status: 'running',
    lockOpen: false,
    view: null,
    entries: [
      { vseq: 1, at: { phase: 'night', day: 0, night: 1 }, type: 'GAME_START', payload: { seats, composition: ['werewolf'], extras: 0, rules: {} } },
      { vseq: 2, at: { phase: 'night', day: 0, night: 1 }, type: 'PHASE_START', payload: { phase: 'night' } },
    ],
    lastVseq: 2,
    pending: null,
    ...extra,
  }) as ServerMessage;

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    // no storage
  }
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the page, as the host uses it', () => {
  it('"Create the links" sends no JSON header without a body, so the server accepts it', async () => {
    const ws = await boot('/?game=g1', true);
    ws!.deliver({ type: 'lobby_state', lobby: { gameId: 'g1', slot: null, connectedSlots: [] } } as ServerMessage);
    await settle();
    button('Create the links')!.click();
    await settle();
    const call = calls.find((c) => c.url.endsWith('/links'))!;
    expect(call.method).toBe('POST');
    expect(call.headers['Content-Type']).toBeUndefined();
    expect(text()).toContain('192.168.1.5:3000/join/abc');
    expect(text()).not.toMatch(/Bad Request|rejoin code [0-9A-F]{6}/);
  });

  it('after a reload during a pause, the host gets Resume, and pressing it resumes', async () => {
    const ws = await boot('/?game=g1', true);
    ws!.deliver(started('host', { status: 'paused', pauseReason: 'recovered' }));
    ws!.deliver({ type: 'host_status', scope: 'host', status: 'paused', pauseReason: 'recovered', disconnectedSlots: [], costUsd: 0, costCapUsd: 2, lockOpen: false, debriefPending: false } as ServerMessage);
    await settle();
    expect(button('Pause')).toBeUndefined();
    button('Resume')!.click();
    expect(ws!.sent.at(-1)).toEqual({ type: 'host_command', scope: 'host', command: { cmd: 'resume' } });
  });

  it('Abort reaches the server, and its answer is shown', async () => {
    const ws = await boot('/?game=g1', true);
    ws!.deliver(started('host', { status: 'paused', pauseReason: 'not_loaded' }));
    ws!.deliver({ type: 'host_status', scope: 'host', status: 'paused', pauseReason: 'not_loaded', disconnectedSlots: [], costUsd: 0, costCapUsd: 2, lockOpen: false, debriefPending: false } as ServerMessage);
    await settle();
    expect(button('Resume')).toBeUndefined(); // it cannot go on here
    button('Abort')!.click();
    expect(ws!.sent.at(-1)).toEqual({ type: 'host_command', scope: 'host', command: { cmd: 'abort' } });
    ws!.deliver({ type: 'command_result', scope: 'host', cmd: 'abort', ok: true, message: 'the game was aborted' } as ServerMessage);
    await settle();
    expect(text()).toContain('the game was aborted');
  });

  it('opening "/" shows the games and New game, not the last game', async () => {
    localStorage.setItem('ww.game', 'g-old');
    const ws = await boot('/', true);
    expect(ws).toBeNull();
    expect(text()).toContain('Choose a game mode');
    expect(text()).toContain('Create the lobby');
  });
});

describe('the page, as a player uses it', () => {
  it('keeps the rejoin code from the link on this device only, and out of the address bar', async () => {
    await boot('/?game=g1#rejoin=A1B2C3', false);
    expect(localStorage.getItem('ww.rejoin.g1')).toBe('A1B2C3');
    expect(location.hash).toBe('');
  });

  it('an answer that cannot be sent is kept, and the warning goes once the connection is back', async () => {
    const ws = await boot('/?game=g1', false);
    ws!.deliver(started('seat', { pending: { clientRequestId: 'r1', kind: 'vote', context: 'day', legal: { targets: [1, 2] }, optional: false, deadlineAt: Date.now() + 60_000, remainingMs: 60_000 } }));
    await settle();
    button('P1')!.click();
    await settle();
    ws!.readyState = 3; // the connection drops without a close event yet
    button('Send')!.click();
    await settle();
    expect(text()).toContain('You are offline');
    expect(button('Send')!.disabled).toBe(false); // nothing was lost: it can be sent again

    ws!.close(1006);
    await new Promise((r) => setTimeout(r, 1100)); // the first retry comes after a second
    const again = FakeSocket.all.at(-1)!;
    expect(again).not.toBe(ws);
    again.open();
    await settle();
    expect(text()).not.toContain('You are offline');
  });

  it('a seat given to a model is told so, and stops retrying', async () => {
    const ws = await boot('/?game=g1', false);
    ws!.close(1008, 'the game started without you, so your seat was given to a model');
    await settle();
    expect(text()).toContain('given to a model');
    await new Promise((r) => setTimeout(r, 1100));
    expect(FakeSocket.all).toHaveLength(1);
  });
});

describe('the page (review round 4)', () => {
  it('a spectator link can be made from the lobby without touching the players’ links', async () => {
    const ws = await boot('/?game=g1', true);
    ws!.deliver({ type: 'lobby_state', lobby: { gameId: 'g1', slot: null, connectedSlots: [] } } as ServerMessage);
    await settle();
    button('Create a spectator link')!.click();
    await settle();
    expect(calls.some((c) => c.url.endsWith('/spectator-link'))).toBe(true);
    expect(calls.some((c) => c.url.endsWith('/links'))).toBe(false);
    expect(text()).toContain('192.168.1.5:3000/spectate/xyz');
  });

  it('a wrong host token is said so, not silently ignored', async () => {
    await boot('/', false);
    const input = document.querySelector<HTMLInputElement>('input[type="password"]')!;
    input.value = 'wrong';
    button('Sign in as host')!.click();
    await settle();
    expect(text()).toContain('that is not the host token');
  });

  it('a host who is not playing gets the controls first on a narrow screen', async () => {
    const ws = await boot('/?game=g1', true);
    ws!.deliver(started('host'));
    await settle();
    expect(document.querySelector('.main')!.classList.contains('hosting')).toBe(true);
  });
});
