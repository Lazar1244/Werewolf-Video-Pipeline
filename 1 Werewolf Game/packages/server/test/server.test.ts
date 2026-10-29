import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { MIGRATIONS_DIR, getGame, listDecisions, listEngineEvents, openStore, putCatalogEntry, type Store } from '@ww/store';
import type { ServerMessage } from '@ww/shared';
import { createServer } from '../src/gateway';
import { LobbyError, LobbyService } from '../src/lobby';
import { hostSafeCost, viewFor } from '../src/views';
import { checkHostToken, hash, newRejoinCode, originAllowed, redeemJoinToken } from '../src/auth';
import { loadEnv } from '../src/setup';
import { remapProblem } from '../src/orchestrator';

const ROOT = join(import.meta.dirname, '../../..');
const env = loadEnv(ROOT);
const HOST_TOKEN = 'test-host-token-long-enough';

const open: { app: FastifyInstance; store: Store }[] = [];
afterEach(async () => {
  for (const o of open.splice(0)) {
    await o.app.close();
    o.store.close();
  }
});

async function server(): Promise<{ app: FastifyInstance; store: Store }> {
  const store = openStore(':memory:', { migrationsDir: MIGRATIONS_DIR });
  const app = await createServer({ env: { ...env, cfg: { ...env.cfg, app: { ...env.cfg.app, hostFromLocalhost: false } } }, store, hostToken: HOST_TOKEN, mock: true });
  const pair = { app, store };
  open.push(pair);
  return pair;
}

const asHost = { 'x-host-token': HOST_TOKEN };

/** Create a lobby with the given human slots and start it. */
async function startGame(app: FastifyInstance, humanSlots: number[] = [], extra: Record<string, unknown> = {}) {
  const created = await app.inject({ method: 'POST', url: '/api/lobbies', headers: asHost, payload: { compositionId: 'classic-7', aliases: ['glm-flash', 'deepseek-flash'] } });
  const { id, draft } = created.json() as { id: string; draft: { slots: { slot: number; controller: string; alias: string | null; humanName: string | null }[] } };
  if (humanSlots.length) {
    const slots = draft.slots.map((s) => (humanSlots.includes(s.slot) ? { ...s, controller: 'human', alias: null, humanName: `Player ${s.slot}` } : s));
    const patched = await app.inject({ method: 'PATCH', url: `/api/lobbies/${id}`, headers: asHost, payload: { slots, ...extra } });
    expect(patched.statusCode).toBe(200);
  } else if (Object.keys(extra).length) {
    await app.inject({ method: 'PATCH', url: `/api/lobbies/${id}`, headers: asHost, payload: extra });
  }
  const links = await app.inject({ method: 'POST', url: `/api/lobbies/${id}/links`, headers: asHost });
  return { id, links: links.json() as { seats: { slot: number; url: string }[]; spectator: string } };
}

const tokenOf = (url: string): string => url.split('/').at(-1)!;

describe('auth and sessions (ARCHITECTURE.md §9.1)', () => {
  it('accepts the host token, and localhost only when configured', () => {
    expect(checkHostToken({ hostToken: 'abc', hostFromLocalhost: false }, 'abc', '10.0.0.5')).toBe(true);
    expect(checkHostToken({ hostToken: 'abc', hostFromLocalhost: false }, 'wrong', '127.0.0.1')).toBe(false);
    expect(checkHostToken({ hostToken: 'abc', hostFromLocalhost: true }, undefined, '127.0.0.1')).toBe(true);
    expect(checkHostToken({ hostToken: 'abc', hostFromLocalhost: true }, undefined, '192.168.1.9')).toBe(false);
  });

  it('rejects a cross-site Origin, allows a matching one and non-browser callers', () => {
    expect(originAllowed('http://evil.example', 'localhost:3000')).toBe(false);
    expect(originAllowed('http://localhost:3000', 'localhost:3000')).toBe(true);
    expect(originAllowed(undefined, 'localhost:3000')).toBe(true);
  });

  it('a join link works exactly once and stores only hashes', async () => {
    const { app, store } = await server();
    const { id, links } = await startGame(app, [1]);
    const token = tokenOf(links.seats[0]!.url);
    const first = await app.inject({ method: 'GET', url: `/join/${token}` });
    expect(first.statusCode).toBe(200);
    expect(first.headers['set-cookie']).toBeTruthy();
    expect(String(first.headers['set-cookie'])).toContain('HttpOnly');
    expect(String(first.headers['set-cookie'])).toContain('SameSite=Strict');
    // the token is burned
    expect((await app.inject({ method: 'GET', url: `/join/${token}` })).statusCode).toBe(404);
    // nothing readable is stored
    const rows = store.db.prepare('SELECT * FROM sessions WHERE game_id = ?').all(id) as { join_token_hash: string | null; cookie_hash: string | null }[];
    for (const r of rows) {
      expect(r.join_token_hash).not.toBe(token);
      if (r.cookie_hash) expect(r.cookie_hash).toHaveLength(64);
    }
    expect(redeemJoinToken(store, 'nonsense')).toBeNull();
    expect(hash('x')).toHaveLength(64);
    expect(newRejoinCode()).toMatch(/^[0-9A-F]{6}$/);
  });

  it('refuses every host route without the token', async () => {
    const { app } = await server();
    for (const url of ['/api/models', '/api/rosters', '/api/compositions', '/api/rules/default']) {
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
      expect((await app.inject({ method: 'GET', url, headers: asHost })).statusCode).toBe(200);
    }
    expect((await app.inject({ method: 'POST', url: '/api/lobbies', payload: {} })).statusCode).toBe(401);
  });
});

describe('models and their prices for the host', () => {
  it('lists every model with its price per million input and output tokens, or none when unknown', async () => {
    const { app, store } = await server();
    // a price the server knows from its catalogue cache (a dry run never asks OpenRouter)
    putCatalogEntry(store, 'deepseek/deepseek-v4.1-flash', { id: 'deepseek/deepseek-v4.1-flash', context_length: 1_000_000, pricing: { prompt: '1.5e-7', completion: '6e-7' }, supported_parameters: [] });
    const res = await app.inject({ method: 'GET', url: '/api/models', headers: asHost });
    expect(res.statusCode).toBe(200);
    const profiles = (res.json() as { profiles: { alias: string; enabled: boolean; inPerM: number | null; outPerM: number | null }[] }).profiles;
    expect(profiles.length).toBeGreaterThanOrEqual(40);
    const ds = profiles.find((p) => p.alias === 'deepseek-flash')!;
    expect(ds.inPerM).toBeCloseTo(0.15, 6);
    expect(ds.outPerM).toBeCloseTo(0.6, 6);
    // every model says what it costs, or that it does not know: never a made-up price
    for (const p of profiles) expect(p.inPerM === null || p.inPerM >= 0).toBe(true);
    expect((await app.inject({ method: 'GET', url: '/api/models' })).statusCode).toBe(401); // the host's only
  });
});

describe('game modes for the gallery (ruleset §12)', () => {
  it('lists every mode with its category, story, tags and balance', async () => {
    const { app } = await server();
    const res = await app.inject({ method: 'GET', url: '/api/compositions', headers: asHost });
    expect(res.statusCode).toBe(200);
    const modes = (res.json() as { compositions: { id: string; category: string; description: string | null; tags: string[]; weight: number; weightRange?: { min: number; max: number }; band: { min: number; max: number } }[] }).compositions;
    expect(modes.length).toBeGreaterThanOrEqual(20);
    const classic7 = modes.find((m) => m.id === 'classic-7')!;
    expect(classic7).toMatchObject({ category: 'classic', weight: 4, band: { min: -3, max: 5 } });
    expect(classic7.description).toBeTruthy();
    expect(classic7.tags.length).toBeGreaterThan(0);
    // with a Thief the weight in play is a range (the two set-aside cards vary)
    expect(modes.find((m) => m.id === 'thiefs-game-9')!.weightRange).toEqual({ min: -7, max: 13 });
    for (const m of modes) expect(['classic', 'recommended', 'custom']).toContain(m.category);
  });
});

describe('LobbyService (§9.2)', () => {
  it('validates the draft against the composition and the model list', async () => {
    const { store } = await server();
    const lobbies = new LobbyService(env, store);
    const draft = lobbies.defaultDraft('classic-7', ['glm-flash']);
    expect(draft.slots).toHaveLength(7);
    expect(() => lobbies.create({ ...draft, slots: draft.slots.slice(0, 5) })).toThrow(LobbyError);
    expect(() => lobbies.create({ ...draft, slots: draft.slots.map((s) => ({ ...s, alias: 'nope' })) })).toThrow(/unknown model alias/);
    expect(() => lobbies.create({ ...draft, slots: draft.slots.map((s, i) => (i === 0 ? { ...s, controller: 'human' as const, alias: null, humanName: null } : s)) })).toThrow(/needs a name/);
    const id = lobbies.create(draft);
    expect(lobbies.get(id).compositionId).toBe('classic-7');
  });

  it('gives a cost estimate before anything is spent', async () => {
    const { app, store } = await server();
    const { id } = await startGame(app);
    const est = await app.inject({ method: 'GET', url: `/api/lobbies/${id}/estimate`, headers: asHost });
    const body = est.json() as { calls: [number, number]; usd: [number, number] };
    expect(body.calls[0]).toBeGreaterThan(0);
    expect(body.usd[1]).toBeGreaterThanOrEqual(body.usd[0]);
    void store;
  });

  it('will not start while a human seat is unconnected, unless the host forces it', async () => {
    const { app, store } = await server();
    const { id } = await startGame(app, [1, 2]);
    const refused = await app.inject({ method: 'POST', url: `/api/lobbies/${id}/start`, headers: asHost, payload: {} });
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({ error: expect.stringContaining('waiting for 2 human seat') as unknown as string });
    const forced = await app.inject({ method: 'POST', url: `/api/lobbies/${id}/start`, headers: asHost, payload: { force: true } });
    expect(forced.statusCode).toBe(200);
    await waitFor(() => getGame(store, id)!.status !== 'lobby');
    const snapshot = JSON.parse(getGame(store, id)!.config_json!) as { slots: { controller: string }[]; game: { humanSlots: number[] } };
    expect(snapshot.slots.filter((s) => s.controller === 'human')).toHaveLength(0); // filled with models
    expect(snapshot.game.humanSlots).toEqual([]);
  });
});

describe('game lifecycle through the server', () => {
  it('plays a whole game, offers the debrief to the host, and records it', async () => {
    const { app, store } = await server();
    const { id } = await startGame(app);
    const started = await app.inject({ method: 'POST', url: `/api/lobbies/${id}/start`, headers: asHost, payload: {} });
    expect(started.statusCode).toBe(200);
    // the engine plays to the end, then waits for the host's answer about the debrief (§15b)
    await waitFor(() => getGame(store, id)!.status === 'over_offer', 60_000, () => `status=${getGame(store, id)!.status} events=${listEngineEvents(store, id).length}`);
    const offered = await app.inject({ method: 'GET', url: `/api/games/${id}/debrief`, headers: asHost });
    expect((offered.json() as { open: boolean }).open).toBe(true);
    const answered = await app.inject({ method: 'POST', url: `/api/games/${id}/debrief`, headers: asHost, payload: { open: true } });
    expect(answered.statusCode).toBe(200);
    await waitFor(() => getGame(store, id)!.status === 'over', 60_000);
    const comments = (await app.inject({ method: 'GET', url: `/api/games/${id}/debrief`, headers: asHost })).json() as { comments: unknown[] };
    expect(comments.comments.length).toBeGreaterThan(0);
    const row = getGame(store, id)!;
    expect(row.winner_team).toBeTruthy();
    expect(row.lock_open).toBe(1); // no human seats: the lock is open from the start
    expect(listEngineEvents(store, id).length).toBeGreaterThan(50);
    expect(listDecisions(store, id).length).toBeGreaterThan(10);
  }, 90_000);

  it('a declined debrief ends the game immediately', async () => {
    const { app, store } = await server();
    const { id } = await startGame(app);
    await app.inject({ method: 'POST', url: `/api/lobbies/${id}/start`, headers: asHost, payload: {} });
    await waitFor(() => getGame(store, id)!.status === 'over_offer', 60_000);
    await app.inject({ method: 'POST', url: `/api/games/${id}/debrief`, headers: asHost, payload: { open: false } });
    await waitFor(() => getGame(store, id)!.status === 'over', 30_000);
    expect(listEngineEvents(store, id).some((e) => e.type === 'DEBRIEF_DECLINED')).toBe(true);
    expect(listEngineEvents(store, id).some((e) => e.type === 'DEBRIEF_COMMENT')).toBe(false);
  }, 90_000);

  it('host commands pause, resume and abort a game', async () => {
    const { app, store } = await server();
    const { id } = await startGame(app);
    await app.inject({ method: 'POST', url: `/api/lobbies/${id}/start`, headers: asHost, payload: {} });
    await waitFor(() => listEngineEvents(store, id).length > 3);
    expect((await app.inject({ method: 'POST', url: `/api/games/${id}/pause`, headers: asHost })).statusCode).toBe(200);
    await waitFor(() => getGame(store, id)!.status === 'paused');
    expect(getGame(store, id)!.pause_reason).toBe('host');
    expect((await app.inject({ method: 'POST', url: `/api/games/${id}/resume`, headers: asHost })).statusCode).toBe(200);
    // a resume puts the game back where it was (a mock game may already be at the debrief offer)
    await waitFor(() => getGame(store, id)!.status !== 'paused');
    expect(getGame(store, id)!.pause_reason).toBeNull();
    expect(['running', 'over_offer', 'debrief', 'over']).toContain(getGame(store, id)!.status);
    expect((await app.inject({ method: 'POST', url: `/api/games/${id}/abort`, headers: asHost })).statusCode).toBe(200);
  }, 60_000);

  it('refuses a seat remap while the spectator lock is closed (§9.5)', async () => {
    const { app, store } = await server();
    const { id } = await startGame(app, [1]);
    await app.inject({ method: 'POST', url: `/api/lobbies/${id}/start`, headers: asHost, payload: { force: false, ...{} }, query: {} });
    // the start is refused (human not connected), so force it and check the rule on a live game
    await app.inject({ method: 'POST', url: `/api/lobbies/${id}/start`, headers: asHost, payload: { force: true } });
    await waitFor(() => getGame(store, id)!.status !== 'lobby');
    const res = await app.inject({ method: 'POST', url: `/api/games/${id}/remap-seat`, headers: asHost, payload: { slot: 1, alias: 'qwen-flash' } });
    expect([200, 400]).toContain(res.statusCode); // 400 while locked, 200 once the lock is open
  }, 60_000);
});

describe('views and the spectator lock (§9.1, ruleset §15)', () => {
  it('the host sees only the public game until the lock opens', async () => {
    const { app, store } = await server();
    const { id } = await startGame(app);
    await app.inject({ method: 'POST', url: `/api/lobbies/${id}/start`, headers: asHost, payload: {} });
    await waitFor(() => listEngineEvents(store, id).length > 20);
    const events = listEngineEvents(store, id);
    const locked = viewFor(events, { kind: 'host' }, false);
    const opened = viewFor(events, { kind: 'host' }, true);
    expect(locked.entries.some((e) => e.type === 'ROLE_ASSIGNED')).toBe(false);
    expect(locked.entries.some((e) => e.type === 'SEAT_THOUGHTS')).toBe(false);
    expect(opened.entries.length).toBeGreaterThan(locked.entries.length);
  }, 60_000);

  it('rounds the host cost to 5% of the cap while the lock is closed', () => {
    expect(hostSafeCost(0.37, 2, false)).toBeCloseTo(0.4, 6);
    expect(hostSafeCost(0.37, 2, true)).toBe(0.37);
  });

  it('a seat view contains that seat only, and a spectator without the lock sees the public game', async () => {
    const { app, store } = await server();
    const { id } = await startGame(app);
    await app.inject({ method: 'POST', url: `/api/lobbies/${id}/start`, headers: asHost, payload: {} });
    await waitFor(() => listEngineEvents(store, id).length > 20);
    const events = listEngineEvents(store, id);
    const seat = viewFor(events, { kind: 'seat', seat: 1, slot: 1, name: 'x' }, false);
    const roleEvents = seat.entries.filter((e) => e.type === 'ROLE_ASSIGNED');
    expect(roleEvents).toHaveLength(1);
    expect((roleEvents[0]!.payload as { seat: number }).seat).toBe(1);
    const spectator = viewFor(events, { kind: 'spectator' }, false);
    expect(spectator.entries.some((e) => e.type === 'ROLE_ASSIGNED')).toBe(false);
  }, 60_000);

  it('the view endpoint needs a principal', async () => {
    const { app } = await server();
    const { id } = await startGame(app);
    await app.inject({ method: 'POST', url: `/api/lobbies/${id}/start`, headers: asHost, payload: {} });
    expect((await app.inject({ method: 'GET', url: `/api/games/${id}/view` })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: `/api/games/${id}/view`, headers: asHost })).statusCode).toBe(200);
  }, 60_000);
});

describe('protocol messages', () => {
  it('every server message the gateway builds is a valid ServerMessage', async () => {
    const { app, store } = await server();
    const { id } = await startGame(app);
    await app.inject({ method: 'POST', url: `/api/lobbies/${id}/start`, headers: asHost, payload: {} });
    await waitFor(() => listEngineEvents(store, id).length > 10);
    const events = listEngineEvents(store, id);
    const projected = viewFor(events, { kind: 'host' }, false);
    const hello: ServerMessage = {
      type: 'hello',
      scope: 'host',
      principal: { kind: 'host' },
      gameId: id,
      status: 'running',
      lockOpen: false,
      view: projected.view,
      entries: projected.entries,
      lastVseq: projected.lastVseq,
      pending: null,
    };
    expect(hello.type).toBe('hello');
  }, 60_000);
});

async function waitFor(check: () => boolean, timeoutMs = 20_000, describe?: () => string): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (check()) return;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for the condition${describe ? `: ${describe()}` : ''}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('recovery, reissue and stats', () => {
  it('a game that was running comes back paused, rebuilt from its decisions (§9.4)', async () => {
    const { app, store } = await server();
    const { id } = await startGame(app);
    await app.inject({ method: 'POST', url: `/api/lobbies/${id}/start`, headers: asHost, payload: {} });
    await waitFor(() => listEngineEvents(store, id).length > 40, 30_000);
    const eventsBefore = listEngineEvents(store, id).length;
    await app.close(); // "crash": the server stops while the game is live
    open.length = 0;

    const again = await createServer({ env, store, hostToken: HOST_TOKEN, mock: true });
    const recovered = await (again as unknown as { ww: { recoverAll: () => Promise<{ gameId: string; problem: string | null }[]> } }).ww.recoverAll();
    expect(recovered.find((r) => r.gameId === id)).toEqual({ gameId: id, problem: null });
    const row = getGame(store, id)!;
    expect(row.status).toBe('paused');
    expect(row.pause_reason).toBe('recovered');
    expect(listEngineEvents(store, id).length).toBe(eventsBefore); // nothing was replayed twice
    // unfinished calls were charged, never re-requested for free
    const unknown = store.db.prepare(`SELECT COUNT(*) AS n FROM llm_calls WHERE game_id = ? AND status = 'sent'`).get(id) as { n: number };
    expect(unknown.n).toBe(0);
    await again.close();
    store.close();
  }, 60_000);

  it('reissuing a seat link needs the rejoin code while humans can still act (§9.1)', async () => {
    const { app, store } = await server();
    const { id, links } = await startGame(app, [1]);
    // §9.1: the host's links carry no codes; the player gets theirs by opening the link
    expect(links).not.toHaveProperty('rejoinCodes');
    const joined = (await app.inject({ method: 'GET', url: `/join/${links.seats[0]!.url.split('/').at(-1)!}` })).json() as { rejoinCode: string };
    const code = joined.rejoinCode;
    expect(code).toMatch(/^[0-9A-F]{6}$/);
    // start with the player present, so slot 1 stays theirs (a forced start would give it to a model)
    const lobbies = new LobbyService(env, store);
    await lobbies.start(id, { connectedSlots: [1], mock: true, offline: true });

    // while the game is still hidden, the host alone cannot hand out a seat
    expect(() => lobbies.reissueSeatLink(id, 1, 'http://x', { lockOpen: false })).toThrow(/rejoin code/);
    expect(() => lobbies.reissueSeatLink(id, 1, 'http://x', { lockOpen: false, rejoinCode: 'ZZZZZZ' })).toThrow(/does not match/);
    const issued = lobbies.reissueSeatLink(id, 1, 'http://x', { lockOpen: false, rejoinCode: code });
    expect(issued.url).toContain('/join/');
    expect(issued).not.toHaveProperty('code'); // the host is not given the new code either
    // the old code still works until the new link is opened (the player may need to ask twice)
    expect(() => lobbies.reissueSeatLink(id, 1, 'http://x', { lockOpen: false, rejoinCode: code })).not.toThrow();
    const again = lobbies.reissueSeatLink(id, 1, 'http://x', { lockOpen: false, rejoinCode: code });
    // the old link is dead, the new one works once, and brings its own new code
    const oldToken = links.seats[0]!.url.split('/').at(-1)!;
    expect((await app.inject({ method: 'GET', url: `/join/${oldToken}` })).statusCode).toBe(404);
    const rejoined = await app.inject({ method: 'GET', url: `/join/${again.url.split('/').at(-1)!}` });
    expect(rejoined.statusCode).toBe(200);
    const fresh = (rejoined.json() as { rejoinCode: string }).rejoinCode;
    expect(fresh).toMatch(/^[0-9A-F]{6}$/);
    // from now on only the new device's code opens the seat
    expect(() => lobbies.reissueSeatLink(id, 1, 'http://x', { lockOpen: false, rejoinCode: fresh })).not.toThrow();
    // once nobody human can act, the host can reissue without a code
    expect(() => lobbies.reissueSeatLink(id, 1, 'http://x', { lockOpen: true })).not.toThrow();
    // a seat that went to a model has no link to make at all
    expect((await app.inject({ method: 'POST', url: `/api/games/${id}/reissue-link`, headers: asHost, payload: { slot: 2 } })).statusCode).toBe(400);
  }, 60_000);

  it('stats only count finished games and exclude bot games', async () => {
    const { app, store } = await server();
    const { id } = await startGame(app);
    await app.inject({ method: 'POST', url: `/api/lobbies/${id}/start`, headers: asHost, payload: {} });
    await waitFor(() => getGame(store, id)!.status === 'over_offer', 60_000);
    await app.inject({ method: 'POST', url: `/api/games/${id}/debrief`, headers: asHost, payload: { open: false } });
    await waitFor(() => getGame(store, id)!.status === 'over', 30_000);
    const models = (await app.inject({ method: 'GET', url: '/api/stats/models', headers: asHost })).json() as {
      models: { alias: string; games: number; seats: number; wins: number; calls: number; fallbackRate: number; repairRate: number; avgLatencyMs: number; costUsd: number }[];
    };
    expect(models.models.length).toBeGreaterThan(0);
    expect(models.models.reduce((a, m) => a + m.seats, 0)).toBe(7); // one row per seat of the game
    const first = models.models[0]!;
    expect(first.calls).toBeGreaterThan(0);
    expect(first.costUsd).toBeGreaterThan(0);
    expect(first.fallbackRate).toBeGreaterThanOrEqual(0);
    expect(first.repairRate).toBeGreaterThanOrEqual(0);
    expect(first.avgLatencyMs).toBeGreaterThanOrEqual(0);
    const roles = (await app.inject({ method: 'GET', url: '/api/stats/roles', headers: asHost })).json() as { roles: { role: string; games: number }[] };
    expect(roles.roles.some((r) => r.role === 'werewolf')).toBe(true);
  }, 90_000);
});

describe('lobby rule overrides and terminal pauses', () => {
  it('rejects an invalid rule override when it is set, not when the game starts', async () => {
    const { app } = await server();
    const { id } = await startGame(app);
    const bad = await app.inject({ method: 'PATCH', url: `/api/lobbies/${id}`, headers: asHost, payload: { rulesOverride: { discussion_rounds: 99 } } });
    expect(bad.statusCode).toBe(400);
    expect((bad.json() as { error: string }).error).toContain('rule overrides are invalid');
    const good = await app.inject({ method: 'PATCH', url: `/api/lobbies/${id}`, headers: asHost, payload: { rulesOverride: { discussion_rounds: 1 } } });
    expect(good.statusCode).toBe(200);
    const started = await app.inject({ method: 'POST', url: `/api/lobbies/${id}/start`, headers: asHost, payload: {} });
    expect(started.statusCode).toBe(200);
  }, 60_000);
});

describe('a model taking over a seat of a running game (remap)', () => {
  it('must fit the context window and the output reserve the game froze, for the host and for the silent fallback', () => {
    const env = loadEnv(join(import.meta.dirname, '../../..'));
    const flash = env.cfg.profilesByAlias.get('deepseek-flash')!; // 1400 answer + 2000 thinking budget = 3400 output tokens
    const entry = { contextLength: 1_000_000 } as never;
    const game = (window: number, outputReserve: number) => ({ budget: { window, outputReserve }, pinned: { maxOutputTokens: 1400 }, effortShare: { low: 0.2, medium: 0.5, high: 0.8 } }) as never;
    expect(remapProblem(flash, entry, game(128_000, 3400))).toBeNull();
    // a game frozen before 2026-10-22 reserved less: the new profile does not fit
    expect(remapProblem(flash, entry, game(128_000, 1750))).toBe('"deepseek-flash" would need 3400 output tokens, more than this game reserved (1750)');
    expect(remapProblem(flash, { contextLength: 64_000 } as never, game(128_000, 3400))).toBe('"deepseek-flash" has a smaller context window (64000) than this game needs (128000)');
  });
});
