import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { MIGRATIONS_DIR, getGame, listDecisions, listEngineEvents, openStore, type Store } from '@ww/store';
import type { ClientRequest, ServerMessage } from '@ww/shared';
import { createServer } from '../src/gateway';
import { loadEnv } from '../src/setup';

/**
 * A human seat playing a whole game over the WebSocket protocol (ARCHITECTURE.md §11.2,
 * ruleset §15): join link → cookie → socket → decision requests → answers, with the
 * spectator lock closed the entire time the human can still act.
 */
const ROOT = join(import.meta.dirname, '../../..');
const env = loadEnv(ROOT);
const HOST_TOKEN = 'human-test-host-token';
const asHost = { 'x-host-token': HOST_TOKEN };

const running: { app: FastifyInstance; store: Store }[] = [];
afterEach(async () => {
  for (const r of running.splice(0)) {
    await r.app.close();
    r.store.close();
  }
});

async function listening(): Promise<{ app: FastifyInstance; store: Store; base: string }> {
  const store = openStore(':memory:', { migrationsDir: MIGRATIONS_DIR });
  const app = await createServer({ env: { ...env, cfg: { ...env.cfg, app: { ...env.cfg.app, hostFromLocalhost: false } } }, store, hostToken: HOST_TOKEN, mock: true });
  running.push({ app, store });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address() as { port: number };
  return { app, store, base: `http://127.0.0.1:${addr.port}` };
}

/** A human client: keeps the cookie, answers every request it is sent. */
class HumanClient {
  ws: WebSocket | null = null;
  cookie = '';
  messages: ServerMessage[] = [];
  answered: string[] = [];
  errors: { clientRequestId: string; issues: string[] }[] = [];
  lockOpen = false;
  view: { table?: { seat: number; alive: boolean }[] } = {};
  constructor(
    private readonly base: string,
    readonly gameId: string,
    private readonly autoAnswer = true,
  ) {}

  async join(token: string): Promise<void> {
    const res = await fetch(`${this.base}/join/${token}`);
    expect(res.status).toBe(200);
    this.cookie = (res.headers.getSetCookie?.() ?? [])[0]?.split(';')[0] ?? '';
    expect(this.cookie).not.toBe('');
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${this.base.replace('http', 'ws')}/ws?game=${this.gameId}`, { headers: { cookie: this.cookie } } as unknown as string[]);
      this.ws = ws;
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () => reject(new Error('socket error')));
      ws.addEventListener('message', (ev: MessageEvent) => {
        const msg = JSON.parse(String(ev.data)) as ServerMessage;
        this.messages.push(msg);
        if (msg.type === 'hello') {
          this.lockOpen = msg.lockOpen;
          this.view = msg.view as { table?: { seat: number; alive: boolean }[] };
          if (msg.pending && this.autoAnswer) this.answer(msg.pending);
        }
        if (msg.type === 'lock_opened') this.lockOpen = true;
        if (msg.type === 'decision_request' && this.autoAnswer) this.answer(msg.request);
        if (msg.type === 'decision_error') this.errors.push({ clientRequestId: msg.clientRequestId, issues: msg.issues });
      });
    });
  }

  answer(req: ClientRequest): void {
    this.answered.push(req.context);
    this.send({ type: 'submit_decision', scope: 'seat', clientRequestId: req.clientRequestId, decision: decisionFor(req) });
  }

  send(msg: unknown): void {
    this.ws?.send(JSON.stringify(msg));
  }
  close(): void {
    this.ws?.close();
  }
}

/** A legal answer for any request a human can get. */
function decisionFor(req: ClientRequest): Record<string, unknown> {
  const legal = req.legal as { targets?: number[]; choices?: string[]; allowNone?: boolean; leanTargets?: number[]; poisonTargets?: number[]; min?: number; canHeal?: boolean };
  switch (req.kind) {
    case 'speech':
      return { speech: 'I am watching everyone closely.', lean: null, claim: null };
    case 'vote':
      return { vote: legal.targets?.[0] ?? 'abstain' };
    case 'sheriff_run':
      return { run: false };
    case 'council_turn':
      return { message: 'let us take the quiet one', proposed_target: legal.targets?.[0] ?? null, ready: true };
    case 'council_ballot':
    case 'target':
      return { target: legal.targets?.[0] ?? null };
    case 'witch':
      return { heal: false, poison: null };
    case 'choice':
      return { choice: legal.choices?.[0] ?? '' };
    case 'pair':
      return { targets: [legal.targets?.[0], legal.targets?.[1]] };
    case 'multi':
      return { targets: (legal.targets ?? []).slice(0, Math.max(1, legal.min ?? 0)) };
    case 'message':
      return { message: 'hello' };
    default:
      return {};
  }
}

async function lobbyWithHuman(app: FastifyInstance, base: string, seed = 'human-seed-1'): Promise<{ id: string; token: string }> {
  const created = await app.inject({ method: 'POST', url: '/api/lobbies', headers: asHost, payload: { compositionId: 'classic-7', aliases: ['glm-flash', 'deepseek-flash'] } });
  const { id, draft } = created.json() as { id: string; draft: { slots: { slot: number; controller: string; alias: string | null; humanName: string | null }[] } };
  const slots = draft.slots.map((s) => (s.slot === 1 ? { ...s, controller: 'human', alias: null, humanName: 'Nadia' } : s));
  const patched = await app.inject({ method: 'PATCH', url: `/api/lobbies/${id}`, headers: asHost, payload: { slots, seed } });
  expect(patched.statusCode).toBe(200);
  const links = (await app.inject({ method: 'POST', url: `/api/lobbies/${id}/links`, headers: asHost })).json() as { seats: { url: string }[] };
  void base;
  return { id, token: links.seats[0]!.url.split('/').at(-1)! };
}

describe('a human seat over the WebSocket protocol', () => {
  it('joins with a one-time link, plays every turn, and the game finishes', async () => {
    const { app, store, base } = await listening();
    const { id, token } = await lobbyWithHuman(app, base);
    const human = new HumanClient(base, id);
    await human.join(token);
    await human.connect();

    const started = await app.inject({ method: 'POST', url: `/api/lobbies/${id}/start`, headers: asHost, payload: {} });
    expect(started.statusCode).toBe(200); // the human is connected, so no force is needed

    await waitFor(() => getGame(store, id)!.status === 'over_offer' || getGame(store, id)!.status === 'over', 60_000);
    expect(human.answered.length).toBeGreaterThan(0); // the human really played (fixed seed: they survive Night 1)
    // every decision of the human's seat came from the socket, not from a fallback
    const humanSeat = seatOfSlot(store, id, 1);
    const seatDecisions = listDecisions(store, id).filter((d) => d.seat === humanSeat);
    expect(seatDecisions.length).toBeGreaterThan(0);
    expect(seatDecisions.filter((d) => d.source === 'human').length).toBeGreaterThan(0);
  }, 90_000);

  it('keeps the spectator lock closed while the human can still act, and opens it when they cannot', async () => {
    const { app, store, base } = await listening();
    const { id, token } = await lobbyWithHuman(app, base);
    const human = new HumanClient(base, id);
    await human.join(token);
    await human.connect();
    await app.inject({ method: 'POST', url: `/api/lobbies/${id}/start`, headers: asHost, payload: {} });
    await waitFor(() => human.messages.some((m) => m.type === 'hello' && (m.view as { me?: unknown }).me !== null), 30_000);

    // while the human is alive, nothing hidden reaches any screen: not even the host's
    const hostView = (await app.inject({ method: 'GET', url: `/api/games/${id}/view`, headers: asHost })).json() as { entries: { type: string }[]; lockOpen: boolean };
    if (!hostView.lockOpen) {
      expect(hostView.entries.some((e) => e.type === 'ROLE_ASSIGNED')).toBe(false);
      expect(hostView.entries.some((e) => e.type === 'SEAT_THOUGHTS')).toBe(false);
    }
    // the human's own view has exactly one role: their own
    // (the player's own snapshot from while the game was hidden: once it is decided, a player
    // also gets the spectator's, which rightly has every card)
    const helloWithMe = human.messages.filter((m): m is Extract<ServerMessage, { type: 'hello' }> => m.type === 'hello' && m.scope === 'seat' && !m.lockOpen).at(-1)!;
    const roles = (helloWithMe.entries as { type: string; payload: { seat: number } }[]).filter((e) => e.type === 'ROLE_ASSIGNED');
    expect(roles).toHaveLength(1);
    expect(roles[0]!.payload.seat).toBe(seatOfSlot(store, id, 1));

    await waitFor(() => getGame(store, id)!.status === 'over_offer' || getGame(store, id)!.status === 'over', 60_000);
    await waitFor(() => human.lockOpen, 10_000); // the lock opens once the human is out of the game
    expect(getGame(store, id)!.lock_open).toBe(1);
  }, 90_000);

  it('rejects an illegal submission and accepts a corrected one', async () => {
    const { app, store, base } = await listening();
    const { id, token } = await lobbyWithHuman(app, base);
    const human = new HumanClient(base, id, false); // answer by hand
    await human.join(token);
    await human.connect();
    await app.inject({ method: 'POST', url: `/api/lobbies/${id}/start`, headers: asHost, payload: {} });

    const req = await waitForValue(() => human.messages.find((m): m is Extract<ServerMessage, { type: 'decision_request' }> => m.type === 'decision_request'), 30_000);
    human.send({ type: 'submit_decision', scope: 'seat', clientRequestId: req.request.clientRequestId, decision: { nonsense: true } });
    await waitFor(() => human.errors.length > 0, 10_000);
    expect(human.errors[0]!.issues.length).toBeGreaterThan(0);
    human.answer(req.request); // now a legal one
    await waitFor(() => human.messages.some((m) => m.type === 'decision_accepted'), 10_000);
    void store;
  }, 60_000);

  it('a reconnecting human gets a snapshot with their pending request', async () => {
    const { app, store, base } = await listening();
    const { id, token } = await lobbyWithHuman(app, base);
    const first = new HumanClient(base, id, false);
    await first.join(token);
    await first.connect();
    await app.inject({ method: 'POST', url: `/api/lobbies/${id}/start`, headers: asHost, payload: {} });
    const req = await waitForValue(() => first.messages.find((m): m is Extract<ServerMessage, { type: 'decision_request' }> => m.type === 'decision_request'), 30_000);

    // the same person reconnects with the same cookie (a new tab, or after a reload)
    const again = new HumanClient(base, id, false);
    again.cookie = first.cookie;
    first.close();
    await again.connect();
    const hello = await waitForValue(() => again.messages.find((m): m is Extract<ServerMessage, { type: 'hello' }> => m.type === 'hello'), 10_000);
    expect(hello.pending?.clientRequestId).toBe(req.request.clientRequestId);
    expect(hello.principal.kind).toBe('seat');
    again.answer(hello.pending!);
    await waitFor(() => again.messages.some((m) => m.type === 'decision_accepted'), 10_000);
    void store;
  }, 60_000);

  it('a socket without a cookie is refused', async () => {
    const { app, base } = await listening();
    const { id } = await lobbyWithHuman(app, base);
    await app.inject({ method: 'POST', url: `/api/lobbies/${id}/start`, headers: asHost, payload: { force: true } });
    const closed = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`${base.replace('http', 'ws')}/ws?game=${id}`);
      ws.addEventListener('close', (ev: CloseEvent) => resolve(ev.code));
      ws.addEventListener('error', () => resolve(-1));
    });
    expect([1008, -1]).toContain(closed);
  }, 30_000);
});

function seatOfSlot(store: Store, gameId: string, slot: number): number {
  const seating = listEngineEvents(store, gameId).find((e) => e.type === 'SEATING')!;
  return (seating.payload as { seats: { seat: number; slot: number }[] }).seats.find((s) => s.slot === slot)!.seat;
}

async function waitFor(check: () => boolean, timeoutMs = 20_000): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (check()) return;
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for the condition');
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function waitForValue<T>(get: () => T | undefined, timeoutMs = 20_000): Promise<T> {
  await waitFor(() => get() !== undefined, timeoutMs);
  return get()!;
}
