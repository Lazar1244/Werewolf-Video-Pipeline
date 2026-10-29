import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { MIGRATIONS_DIR, getGame, listEngineEvents, openStore, type Store } from '@ww/store';
import { assignRole, type Deal } from '@ww/shared';
import { createServer } from '../src/gateway';
import { LobbyError, LobbyService } from '../src/lobby';
import { buildGame, loadEnv } from '../src/setup';
import { viewFor } from '../src/views';

// A custom game (owner request, 2026-10-26): the host picks the mode, puts a model (or a person)
// at each seat and gives each seat its role. Nothing is dealt at random.
const ROOT = join(import.meta.dirname, '../../..');
const env = loadEnv(ROOT);
const HOST_TOKEN = 'test-host-token-long-enough';
const asHost = { 'x-host-token': HOST_TOKEN };

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
  open.push({ app, store });
  return { app, store };
}

async function waitFor(cond: () => boolean, timeoutMs = 30_000): Promise<void> {
  const started = Date.now();
  while (!cond()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for the condition');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('a custom game in the lobby', () => {
  it('starts from the mode cards, one per seat, and keeps the deal valid', async () => {
    const { store } = await server();
    const lobbies = new LobbyService(env, store);
    const draft = lobbies.defaultDraft('classic-7', ['glm-flash'], true);
    expect(draft.manualDeal).toEqual({ roles: env.cfg.compositions.get('classic-7')!.cards });
    expect(lobbies.defaultDraft('classic-7', ['glm-flash']).manualDeal).toBeUndefined(); // the usual random deal
    const id = lobbies.create(draft);
    // a deal that is not the mode's cards is refused, and the stored draft is unchanged
    expect(() => lobbies.patch(id, { manualDeal: { roles: ['werewolf', 'werewolf', 'werewolf', 'witch', 'hunter', 'villager', 'villager'] } })).toThrow(LobbyError);
    expect(() => lobbies.patch(id, { manualDeal: { roles: ['werewolf', 'werewolf', 'seer', 'witch', 'hunter', 'villager'] } })).toThrow(/7 seats, but 6/);
    expect(lobbies.get(id).manualDeal).toEqual(draft.manualDeal);
    // back to random, and to custom again
    expect(lobbies.patch(id, { manualDeal: null }).manualDeal).toBeNull();
    expect(lobbies.patch(id, { manualDeal: draft.manualDeal }).manualDeal).toEqual(draft.manualDeal);
  });

  it('a Thief mode keeps its two middle cards, and refuses a deal that sets the Thief aside', async () => {
    const { store } = await server();
    const lobbies = new LobbyService(env, store);
    const draft = lobbies.defaultDraft('thiefs-game-9', ['glm-flash'], true);
    expect(draft.manualDeal!.roles).toHaveLength(9);
    expect(draft.manualDeal!.extras).toHaveLength(2);
    const id = lobbies.create(draft);
    const thiefOut = assignRole(draft.manualDeal as Deal, 9, 'thief');
    expect(() => lobbies.patch(id, { manualDeal: thiefOut })).toThrow(/Thief must sit at a seat/);
  });

  it('another mode starts the deal again from that mode', async () => {
    const { store } = await server();
    const lobbies = new LobbyService(env, store);
    const id = lobbies.create(lobbies.defaultDraft('classic-7', ['glm-flash'], true));
    const eight = env.cfg.compositions.get('classic-8')!;
    const slots = Array.from({ length: 8 }, (_, i) => ({ slot: (i + 1) as never, controller: 'ai' as const, alias: 'glm-flash', humanName: null }));
    const next = lobbies.patch(id, { compositionId: 'classic-8', slots });
    expect([...next.manualDeal!.roles].sort()).toEqual([...eight.cards].sort());
  });

  it('freezes the cards in seat order and marks the game as a host deal', async () => {
    const { store } = await server();
    const roles = ['villager', 'seer', 'werewolf', 'witch', 'villager', 'werewolf', 'hunter'] as Deal['roles'];
    const built = await buildGame({ env, store, compositionId: 'classic-7', aliases: ['glm-flash'], seed: 's', costCapUsd: 1, manualDeal: { roles }, offline: true, mock: true });
    expect(built.snapshot.game.cards).toEqual(roles);
    expect(built.snapshot.game.manualDeal).toBe(true);
    const random = await buildGame({ env, store, compositionId: 'classic-7', aliases: ['glm-flash'], seed: 's', costCapUsd: 1, offline: true, mock: true });
    expect(random.snapshot.game.manualDeal).toBeUndefined();
    await expect(buildGame({ env, store, compositionId: 'classic-7', aliases: ['glm-flash'], seed: 's', costCapUsd: 1, manualDeal: { roles: roles.slice(0, 6) }, offline: true, mock: true })).rejects.toThrow(/does not fit/);
  });
});

describe('a custom game played through the server', () => {
  it('each seat gets exactly the model and the role the host gave it', async () => {
    const { app, store } = await server();
    const created = await app.inject({ method: 'POST', url: '/api/lobbies', headers: asHost, payload: { compositionId: 'classic-7', aliases: ['glm-flash'], manual: true } });
    expect(created.statusCode).toBe(200);
    const { id, draft } = created.json() as { id: string; draft: { slots: { slot: number; controller: string; alias: string | null; humanName: string | null }[]; manualDeal: Deal } };
    // the host's table: two models side by side, and the wolves at seats 2 and 6
    const aliases = ['glm-flash', 'deepseek-flash', 'glm-flash', 'deepseek-flash', 'glm-flash', 'deepseek-flash', 'glm-flash'];
    const slots = draft.slots.map((s, i) => ({ ...s, alias: aliases[i]! }));
    let deal = draft.manualDeal;
    deal = assignRole(deal, 1, 'werewolf');
    deal = assignRole(deal, 5, 'werewolf');
    deal = assignRole(deal, 0, 'seer');
    expect(deal.roles.filter((r) => r === 'werewolf')).toHaveLength(2);
    const patched = await app.inject({ method: 'PATCH', url: `/api/lobbies/${id}`, headers: asHost, payload: { slots, manualDeal: deal } });
    expect(patched.statusCode).toBe(200);

    const started = await app.inject({ method: 'POST', url: `/api/lobbies/${id}/start`, headers: asHost, payload: {} });
    expect(started.statusCode).toBe(200);
    await waitFor(() => listEngineEvents(store, id).some((e) => e.type === 'ROLE_ASSIGNED'));
    const events = listEngineEvents(store, id);
    const seating = events.find((e) => e.type === 'SEATING')!.payload as { seats: { seat: number; slot: number }[] };
    expect(seating.seats.map((s) => [s.seat, s.slot])).toEqual([1, 2, 3, 4, 5, 6, 7].map((n) => [n, n]));
    const assigned = events.filter((e) => e.type === 'ROLE_ASSIGNED').map((e) => e.payload as { seat: number; role: string });
    expect(assigned.map((a) => a.role)).toEqual(deal.roles);
    const snapshot = JSON.parse(getGame(store, id)!.config_json!) as { slots: { slot: number; profile: { alias: string } | null }[]; game: { manualDeal?: boolean } };
    expect(snapshot.slots.map((s) => s.profile?.alias)).toEqual(aliases);
    expect(snapshot.game.manualDeal).toBe(true);
    // and it plays on to the end like any game
    await waitFor(() => ['over_offer', 'over'].includes(getGame(store, id)!.status), 60_000);
  }, 90_000);

  it('a Thief game keeps its middle cards, a person learns only their own role, and a forced start keeps the roles', async () => {
    const { app, store } = await server();
    const created = await app.inject({ method: 'POST', url: '/api/lobbies', headers: asHost, payload: { compositionId: 'thiefs-game-9', aliases: ['glm-flash'], manual: true } });
    const { id, draft } = created.json() as { id: string; draft: { slots: { slot: number; controller: string; alias: string | null; humanName: string | null }[]; manualDeal: Deal } };
    // a werewolf and a villager in the middle; seat 2 is a person (who never comes), seat 9 a bot
    let deal = draft.manualDeal;
    deal = assignRole(deal, 9, 'werewolf');
    expect(deal.extras).toContain('werewolf');
    const slots = draft.slots.map((s) => (s.slot === 2 ? { ...s, controller: 'human', alias: null, humanName: 'Ana' } : s.slot === 9 ? { ...s, controller: 'bot', alias: null } : s));
    expect((await app.inject({ method: 'PATCH', url: `/api/lobbies/${id}`, headers: asHost, payload: { slots, manualDeal: deal } })).statusCode).toBe(200);
    const forced = await app.inject({ method: 'POST', url: `/api/lobbies/${id}/start`, headers: asHost, payload: { force: true } });
    expect(forced.statusCode).toBe(200);
    await waitFor(() => listEngineEvents(store, id).some((e) => e.type === 'ROLE_ASSIGNED'));
    const events = listEngineEvents(store, id);
    const assigned = events.filter((e) => e.type === 'ROLE_ASSIGNED');
    // every seat keeps the host's card, and learns it privately (only that seat sees the event)
    expect(assigned.map((e) => (e.payload as { role: string }).role)).toEqual(deal.roles);
    for (const e of assigned) expect(e.vis).toEqual({ kind: 'seats', seats: [(e.payload as { seat: number }).seat] });
    const snapshot = JSON.parse(getGame(store, id)!.config_json!) as { slots: { slot: number; controller: string }[]; game: { cards: string[] } };
    expect(snapshot.game.cards.slice(9)).toEqual(deal.extras); // the middle cards as dealt
    expect(snapshot.slots.find((s) => s.slot === 2)!.controller).toBe('ai'); // the missing person's seat went to a model
    expect(snapshot.slots.find((s) => s.slot === 9)!.controller).toBe('bot');
    await waitFor(() => ['over_offer', 'over'].includes(getGame(store, id)!.status), 60_000);
  }, 90_000);

  it('a seat sees only its own role, and nobody behind the spectator lock sees any', async () => {
    const { app, store } = await server();
    const created = await app.inject({ method: 'POST', url: '/api/lobbies', headers: asHost, payload: { compositionId: 'classic-7', aliases: ['glm-flash'], manual: true } });
    const { id, draft } = created.json() as { id: string; draft: { manualDeal: Deal } };
    const deal = assignRole(draft.manualDeal, 2, 'werewolf'); // seat 3 is a wolf
    expect((await app.inject({ method: 'PATCH', url: `/api/lobbies/${id}`, headers: asHost, payload: { manualDeal: deal } })).statusCode).toBe(200);
    await app.inject({ method: 'POST', url: `/api/lobbies/${id}/start`, headers: asHost, payload: {} });
    await waitFor(() => listEngineEvents(store, id).length > 20);
    const events = listEngineEvents(store, id);
    const seat = viewFor(events, { kind: 'seat', seat: 3, slot: 3, name: 'x' }, false);
    const mine = seat.entries.filter((e) => e.type === 'ROLE_ASSIGNED');
    expect(mine.map((e) => e.payload)).toEqual([{ seat: 3, role: 'werewolf', team: 'Werewolf' }]);
    expect(viewFor(events, { kind: 'spectator' }, false).entries.some((e) => e.type === 'ROLE_ASSIGNED')).toBe(false);
    expect(viewFor(events, { kind: 'host' }, false).entries.some((e) => e.type === 'ROLE_ASSIGNED')).toBe(false);
  }, 60_000);
});
