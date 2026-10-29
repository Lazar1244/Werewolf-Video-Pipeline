import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { MIGRATIONS_DIR, getGame, listDecisions, listEngineEvents, openStore, type Store } from '@ww/store';
import type { ClientRequest, ServerMessage } from '@ww/shared';
import { applyMessage, emptyState, request, type ClientState } from '@ww/client-sdk';
import { HOST_COOKIE } from '../src/auth';
import { createServer, lanAddress } from '../src/gateway';
import { loadEnv } from '../src/setup';

/**
 * The parts of §9.3–§9.5 that only show up in a game that is genuinely mid-flight: pausing,
 * resuming, the cost cap, crash recovery, abort, and the host's "fallback now".
 *
 * Every test here holds the game still with a human seat that does not answer, so the game
 * cannot race past the thing being tested.
 */
const ROOT = join(import.meta.dirname, '../../..');
const env = loadEnv(ROOT);
const HOST = 'orchestration-host-token';
const asHost = { 'x-host-token': HOST };

const running: { app: FastifyInstance; store: Store }[] = [];
afterEach(async () => {
  for (const r of running.splice(0)) {
    await r.app.close();
    try {
      r.store.close();
    } catch {
      // already closed by the test
    }
  }
});

async function listening(
  store = openStore(':memory:', { migrationsDir: MIGRATIONS_DIR }),
  appOverrides: Record<string, unknown> = {},
): Promise<{ app: FastifyInstance; store: Store; base: string }> {
  const app = await createServer({
    env: { ...env, cfg: { ...env.cfg, app: { ...env.cfg.app, hostFromLocalhost: false, ...appOverrides } } },
    store,
    hostToken: HOST,
    mock: true,
  });
  running.push({ app, store });
  await app.listen({ port: 0, host: '127.0.0.1' });
  return { app, store, base: `http://127.0.0.1:${(app.server.address() as { port: number }).port}` };
}

/** A human that connects but only answers when told to: it holds the game still. */
class Holder {
  ws: WebSocket | null = null;
  cookie = '';
  requests: ClientRequest[] = [];
  messages: ServerMessage[] = [];
  state: ClientState = emptyState();
  constructor(
    private readonly base: string,
    private readonly gameId: string,
  ) {}

  /** The rejoin code this device was given when it opened its link (only it ever sees it). */
  rejoinCode: string | null = null;

  async join(token: string): Promise<void> {
    const res = await fetch(`${this.base}/join/${token}`);
    this.cookie = (res.headers.getSetCookie?.() ?? [])[0]?.split(';')[0] ?? '';
    this.rejoinCode = ((await res.json().catch(() => ({}))) as { rejoinCode?: string }).rejoinCode ?? null;
  }

  connect(extraCookies = ''): Promise<void> {
    return new Promise((resolve, reject) => {
      const cookie = extraCookies ? `${this.cookie}; ${extraCookies}` : this.cookie;
      const ws = new WebSocket(`${this.base.replace('http', 'ws')}/ws?game=${this.gameId}`, { headers: { cookie } } as unknown as string[]);
      this.ws = ws;
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () => reject(new Error('socket error')));
      ws.addEventListener('message', (ev: MessageEvent) => {
        const msg = JSON.parse(String(ev.data)) as ServerMessage;
        this.messages.push(msg);
        this.state = applyMessage(this.state, msg).state;
        if (msg.type === 'decision_request') this.requests.push(msg.request);
        if (msg.type === 'hello' && msg.pending) this.requests.push(msg.pending);
      });
    });
  }

  answerAll(): void {
    for (const r of this.requests.splice(0)) {
      const legal = r.legal as { targets?: number[]; choices?: string[]; min?: number };
      const decision =
        r.kind === 'speech'
          ? { speech: 'I am thinking.', lean: null, claim: null }
          : r.kind === 'vote'
            ? { vote: legal.targets?.[0] ?? 'abstain' }
            : r.kind === 'sheriff_run'
              ? { run: false }
              : r.kind === 'witch'
                ? { heal: false, poison: null }
                : r.kind === 'choice'
                  ? { choice: legal.choices?.[0] ?? '' }
                  : r.kind === 'council_turn'
                    ? { message: 'ok', proposed_target: legal.targets?.[0] ?? null, ready: true }
                    : r.kind === 'multi'
                      ? { targets: (legal.targets ?? []).slice(0, Math.max(1, legal.min ?? 0)) }
                      : r.kind === 'pair'
                        ? { targets: [legal.targets?.[0], legal.targets?.[1]] }
                        : r.kind === 'message'
                          ? { message: 'hi' }
                          : { target: legal.targets?.[0] ?? null };
      this.ws?.send(JSON.stringify({ type: 'submit_decision', scope: 'seat', clientRequestId: r.clientRequestId, decision }));
    }
  }
  close(): void {
    this.ws?.close();
  }
}

/** A started game with one human seat that is connected but silent. */
async function heldGame(opts: { cap?: number; store?: Store; app?: Record<string, unknown>; rules?: Record<string, unknown> } = {}) {
  const { app, store, base } = await listening(opts.store, opts.app ?? {});
  const created = await app.inject({ method: 'POST', url: '/api/lobbies', headers: asHost, payload: { compositionId: 'classic-7', aliases: ['glm-flash', 'deepseek-flash'] } });
  const { id, draft } = created.json() as { id: string; draft: { slots: { slot: number; controller: string; alias: string | null; humanName: string | null }[] } };
  const slots = draft.slots.map((s) => (s.slot === 1 ? { ...s, controller: 'human', alias: null, humanName: 'Nadia' } : s));
  await app.inject({
    method: 'PATCH',
    url: `/api/lobbies/${id}`,
    headers: asHost,
    payload: { slots, seed: 'held-1', ...(opts.cap ? { costCapUsd: opts.cap } : {}), ...(opts.rules ? { rulesOverride: opts.rules } : {}) },
  });
  const links = (await app.inject({ method: 'POST', url: `/api/lobbies/${id}/links`, headers: asHost })).json() as { seats: { url: string }[] };
  const human = new Holder(base, id);
  await human.join(links.seats[0]!.url.split('/').at(-1)!);
  await human.connect();
  const started = await app.inject({ method: 'POST', url: `/api/lobbies/${id}/start`, headers: asHost, payload: {} });
  expect(started.statusCode).toBe(200);
  await waitFor(() => human.requests.length > 0, 30_000); // the game is now waiting for the human
  return { app, store, base, id, human, links };
}

describe('pause and resume (§9.3)', () => {
  it('a paused game applies nothing, and a resume carries it to the end', async () => {
    const { app, store, id, human } = await heldGame();
    expect((await app.inject({ method: 'POST', url: `/api/games/${id}/pause`, headers: asHost })).statusCode).toBe(200);
    await waitFor(() => getGame(store, id)!.status === 'paused');
    const eventsWhilePaused = listEngineEvents(store, id).length;

    // the human answers during the pause: it is stored, but the game must not move
    human.answerAll();
    await new Promise((r) => setTimeout(r, 400));
    expect(listEngineEvents(store, id).length).toBe(eventsWhilePaused);
    const buffered = store.db.prepare(`SELECT COUNT(*) AS n FROM decisions WHERE game_id = ? AND status = 'buffered'`).get(id) as { n: number };
    expect(buffered.n).toBeGreaterThan(0); // §9.3 step 3: persisted, not applied

    expect((await app.inject({ method: 'POST', url: `/api/games/${id}/resume`, headers: asHost })).statusCode).toBe(200);
    await waitFor(() => listEngineEvents(store, id).length > eventsWhilePaused, 20_000); // the loop woke up
    // the answer given during the pause was used, not thrown away or re-asked
    await waitFor(() => (store.db.prepare(`SELECT COUNT(*) AS n FROM decisions WHERE game_id = ? AND status = 'buffered'`).get(id) as { n: number }).n === 0, 20_000);
    const answerLoop = setInterval(() => human.answerAll(), 50);
    await waitFor(() => ['over_offer', 'over'].includes(getGame(store, id)!.status), 60_000);
    clearInterval(answerLoop);
  }, 120_000);

  it('a human clock freezes while paused and starts again on resume', async () => {
    const { app, store, base, id, human } = await heldGame();
    expect(human.requests[0]!.deadlineAt).not.toBeNull();
    await app.inject({ method: 'POST', url: `/api/games/${id}/pause`, headers: asHost });
    await waitFor(() => getGame(store, id)!.status === 'paused');

    // the same person reloads their page: the snapshot shows the clock stopped
    human.close();
    const paused = new Holder(base, id);
    paused.cookie = human.cookie;
    await paused.connect();
    const whilePaused = await waitForValue(() => paused.messages.find((m): m is Extract<ServerMessage, { type: 'hello' }> => m.type === 'hello' && !!m.pending), 10_000);
    expect(whilePaused.pending!.deadlineAt).toBeNull(); // frozen (§9.3)

    await app.inject({ method: 'POST', url: `/api/games/${id}/resume`, headers: asHost });
    await waitFor(() => getGame(store, id)!.status !== 'paused');
    paused.close();
    const resumed = new Holder(base, id);
    resumed.cookie = human.cookie;
    await resumed.connect();
    const afterResume = await waitForValue(() => resumed.messages.find((m): m is Extract<ServerMessage, { type: 'hello' }> => m.type === 'hello' && !!m.pending), 10_000);
    expect(afterResume.pending!.deadlineAt).not.toBeNull(); // running again
    resumed.close();
  }, 90_000);

  it('a disconnected human keeps their clock for the grace period, then falls back when away', async () => {
    const { store, id, human } = await heldGame({
      // the only human dropping would otherwise pause the game, which is a different rule
      app: { disconnectGraceMs: 200, disconnectMaxMs: 1200, pauseOnAllHumansDisconnected: false },
      rules: { human_timeouts: { long_text_ms: 60_000, channel_ms: 60_000, other_ms: 60_000 } },
    });
    const seat = seatOfSlot(store, id, 1);
    human.close(); // they drop with a request open and a 60 s deadline
    // after disconnectMaxMs the seat is "away" and the engine gets the ruleset fallback,
    // long before that 60 s deadline would have expired
    await waitFor(() => listDecisions(store, id).some((d) => d.seat === seat && d.source === 'fallback'), 20_000);
    const fallback = listDecisions(store, id).find((d) => d.seat === seat)!;
    expect(fallback.answer).toEqual({ kind: 'no_answer', reason: 'disconnected' });
  }, 60_000);
});

describe('cost cap (§7.5, §9.3)', () => {
  it('pauses at the cap, and raising it lets the game continue', async () => {
    const { app, store } = await listening();
    const created = await app.inject({ method: 'POST', url: '/api/lobbies', headers: asHost, payload: { compositionId: 'classic-7', aliases: ['glm-flash'] } });
    const { id } = created.json() as { id: string };
    await app.inject({ method: 'PATCH', url: `/api/lobbies/${id}`, headers: asHost, payload: { costCapUsd: 0.004, seed: 'cap-1' } });
    await app.inject({ method: 'POST', url: `/api/lobbies/${id}/start`, headers: asHost, payload: {} });
    await waitFor(() => getGame(store, id)!.status === 'paused' && getGame(store, id)!.pause_reason === 'cost_cap', 60_000);
    const spentAtPause = getGame(store, id)!.cost_spent_usd;
    expect(spentAtPause).toBeLessThanOrEqual(0.004);
    const eventsAtPause = listEngineEvents(store, id).length;

    const raised = await app.inject({ method: 'POST', url: `/api/games/${id}/raise-cap`, headers: asHost, payload: { capUsd: 5 } });
    expect(raised.statusCode).toBe(200);
    expect(getGame(store, id)!.cost_cap_usd).toBe(5); // the new cap survives a restart
    await waitFor(() => listEngineEvents(store, id).length > eventsAtPause, 30_000);
    await waitFor(() => ['over_offer', 'over'].includes(getGame(store, id)!.status), 90_000);
    expect(getGame(store, id)!.cost_spent_usd).toBeGreaterThan(spentAtPause);
  }, 150_000);
});

describe('crash recovery (§9.4)', () => {
  it('a recovered game resumes and finishes, without re-buying answers', async () => {
    const store = openStore(':memory:', { migrationsDir: MIGRATIONS_DIR });
    const { app, id, human } = await heldGame({ store });
    human.answerAll(); // this answer is paid for and buffered
    await waitFor(() => listDecisions(store, id).length + 1 > 0, 10_000);
    const callsBefore = (store.db.prepare('SELECT COUNT(*) AS n FROM llm_calls WHERE game_id = ?').get(id) as { n: number }).n;
    await app.close(); // "crash"
    running.length = 0;

    const second = await listening(store);
    const recovered = await (second.app as unknown as { ww: { recoverAll: () => Promise<{ gameId: string; problem: string | null }[]> } }).ww.recoverAll();
    expect(recovered.find((r) => r.gameId === id)?.problem).toBeNull();
    expect(getGame(store, id)!.pause_reason).toBe('recovered');

    // the human comes back and the host resumes: the game must finish
    const back = new Holder(second.base, id);
    back.cookie = human.cookie;
    await back.connect();
    expect((await second.app.inject({ method: 'POST', url: `/api/games/${id}/resume`, headers: asHost })).statusCode).toBe(200);
    const loop = setInterval(() => back.answerAll(), 40);
    await waitFor(() => ['over_offer', 'over'].includes(getGame(store, id)!.status), 90_000);
    clearInterval(loop);
    // no request was answered twice, and every call is accounted for
    const applied = listDecisions(store, id);
    expect(new Set(applied.map((d) => d.requestId)).size).toBe(applied.length);
    const calls = store.db.prepare(`SELECT COUNT(*) AS n FROM llm_calls WHERE game_id = ? AND status = 'sent'`).get(id) as { n: number };
    expect(calls.n).toBe(0);
    expect(callsBefore).toBeGreaterThan(0);
  }, 180_000);
});

describe('abort (§9.3)', () => {
  it('an unfinished game becomes aborted and stays aborted after a restart', async () => {
    const store = openStore(':memory:', { migrationsDir: MIGRATIONS_DIR });
    const { app, id } = await heldGame({ store });
    const res = await app.inject({ method: 'POST', url: `/api/games/${id}/abort`, headers: asHost });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { outcome: string }).outcome).toBe('aborted');
    await waitFor(() => getGame(store, id)!.status === 'aborted');
    await app.close();
    running.length = 0;
    const second = await listening(store);
    const recovered = await (second.app as unknown as { ww: { recoverAll: () => Promise<unknown[]> } }).ww.recoverAll();
    expect((recovered as { gameId: string }[]).some((r) => r.gameId === id)).toBe(false); // not resurrected
  }, 60_000);

  it('aborting the debrief keeps the finished game and its result', async () => {
    const { app, store } = await listening();
    const created = await app.inject({ method: 'POST', url: '/api/lobbies', headers: asHost, payload: { compositionId: 'classic-7', aliases: ['glm-flash'] } });
    const { id } = created.json() as { id: string };
    await app.inject({ method: 'POST', url: `/api/lobbies/${id}/start`, headers: asHost, payload: {} });
    await waitFor(() => getGame(store, id)!.status === 'over_offer', 60_000);
    const res = await app.inject({ method: 'POST', url: `/api/games/${id}/abort`, headers: asHost });
    expect((res.json() as { outcome: string }).outcome).toBe('over');
    const row = getGame(store, id)!;
    expect(row.status).toBe('over');
    expect(row.winner_team).toBeTruthy(); // the result is kept (§9.3)
  }, 90_000);
});

describe('what the browser is told (§9.1, §11.2)', () => {
  it('re-delivers an open request when the clock is frozen and again when it restarts', async () => {
    const { app, id, human } = await heldGame();
    const open = human.requests[0]!;
    const before = human.messages.filter((m) => m.type === 'decision_request').length;

    await app.inject({ method: 'POST', url: `/api/games/${id}/pause`, headers: asHost });
    const frozen = await waitForValue(() =>
      human.messages.filter((m): m is Extract<ServerMessage, { type: 'decision_request' }> => m.type === 'decision_request').find((m, i) => i >= before && m.request.clientRequestId === open.clientRequestId),
    );
    // §9.3: a pause freezes every human clock, so the deadline the browser holds must go away
    expect(frozen.request.deadlineAt).toBeNull();

    const after = human.messages.length;
    await app.inject({ method: 'POST', url: `/api/games/${id}/resume`, headers: asHost });
    const rearmed = await waitForValue(() =>
      human.messages
        .slice(after)
        .filter((m): m is Extract<ServerMessage, { type: 'decision_request' }> => m.type === 'decision_request')
        .find((m) => m.request.clientRequestId === open.clientRequestId),
    );
    expect(rearmed.request.deadlineAt).toBeGreaterThan(Date.now());
  }, 60_000);

  it('tells everyone, not only the host, when the host abandons the game', async () => {
    const { app, id, human } = await heldGame();
    await app.inject({ method: 'POST', url: `/api/games/${id}/abort`, headers: asHost });
    const told = await waitForValue(() => human.messages.find((m) => m.type === 'aborted'));
    expect(told).toBeTruthy();
    expect(human.state.status).toBe('aborted');
    expect(human.state.pending).toBeNull(); // and it stops asking for an answer
  }, 60_000);

  it('keeps the model line-up in the lobby to the host', async () => {
    const { app, base } = await listening();
    const created = await app.inject({ method: 'POST', url: '/api/lobbies', headers: asHost, payload: { compositionId: 'classic-7', aliases: ['glm-flash', 'deepseek-flash'] } });
    const { id, draft } = created.json() as { id: string; draft: { slots: { slot: number; controller: string; alias: string | null; humanName: string | null }[] } };
    const slots = draft.slots.map((x) => (x.slot === 1 ? { ...x, controller: 'human', alias: null, humanName: 'Nadia' } : x));
    await app.inject({ method: 'PATCH', url: `/api/lobbies/${id}`, headers: asHost, payload: { slots } });
    const links = (await app.inject({ method: 'POST', url: `/api/lobbies/${id}/links`, headers: asHost })).json() as { seats: { url: string }[] };

    const player = new Holder(base, id);
    await player.join(links.seats[0]!.url.split('/').at(-1)!);
    await player.connect();
    const host = new Holder(base, id);
    await host.connect(`${HOST_COOKIE}=${HOST}`);

    // any change to the draft is broadcast to the whole lobby room
    await app.inject({ method: 'PATCH', url: `/api/lobbies/${id}`, headers: asHost, payload: { costCapUsd: 3 } });
    await waitFor(() => player.messages.filter((m) => m.type === 'lobby_state').length >= 2);
    const forHost = await waitForValue(() => host.messages.filter((m): m is Extract<ServerMessage, { type: 'lobby_state' }> => m.type === 'lobby_state').at(-1));

    // §9.1: the draft names the models and the people, so only the host may have it — in every
    // message, including the very first one a socket gets when it connects
    const forPlayer = player.messages.filter((m): m is Extract<ServerMessage, { type: 'lobby_state' }> => m.type === 'lobby_state');
    for (const m of forPlayer) {
      expect(m.lobby).not.toHaveProperty('draft');
      expect(JSON.stringify(m.lobby)).not.toMatch(/glm-flash|deepseek-flash|Nadia/);
    }
    expect(forHost.lobby).toHaveProperty('draft');
    expect(JSON.stringify(forHost.lobby)).toContain('glm-flash');
    player.close();
    host.close();
  }, 60_000);

  it('a browser can create the links: a POST with no body is not refused', async () => {
    const { app, base } = await listening();
    const created = await app.inject({ method: 'POST', url: '/api/lobbies', headers: asHost, payload: { compositionId: 'classic-7', aliases: ['glm-flash'] } });
    const { id } = created.json() as { id: string };
    // exactly what the web UI sends (through client-sdk's request): no body, so no JSON header
    const links = await request<{ seats: unknown[]; spectator: string }>(`${base}/api/lobbies/${id}/links`, { method: 'POST', headers: { 'x-host-token': HOST } });
    expect(links.spectator).toContain('/spectate/');
    // and a schema error reads as words, not as raw JSON
    await expect(request(`${base}/api/lobbies/${id}`, { method: 'PATCH', headers: { 'x-host-token': HOST }, body: { costCapUsd: 0 } })).rejects.toThrow(/costCapUsd: /);
  }, 60_000);

  it('a device that connects during a pause is told so, and the host gets the status at once', async () => {
    const { app, base, id } = await heldGame();
    await app.inject({ method: 'POST', url: `/api/games/${id}/pause`, headers: asHost });
    const host = new Holder(base, id);
    await host.connect(`${HOST_COOKIE}=${HOST}`);
    await waitFor(() => host.state.host !== null);
    expect(host.state.paused).toEqual({ reason: 'host' }); // from the snapshot, not from a `paused` message
    expect(host.messages.some((m) => m.type === 'paused')).toBe(false);
    expect(host.state.host!.status).toBe('paused');
    host.close();
  }, 60_000);

  it('withdraws a question that was settled without the player', async () => {
    // the shortest clock the rules allow: the question times out while the player sits there
    const { human } = await heldGame({ rules: { human_timeouts: { long_text_ms: 5_000, channel_ms: 5_000, other_ms: 5_000 } } });
    const open = human.requests[0]!;
    const closed = await waitForValue(
      () => human.messages.find((m): m is Extract<ServerMessage, { type: 'decision_closed' }> => m.type === 'decision_closed' && m.clientRequestId === open.clientRequestId),
      30_000,
    );
    expect(closed.scope).toBe('seat');
    expect(human.state.pending?.clientRequestId).not.toBe(open.clientRequestId);
  }, 60_000);

  it('says which model played each seat once the game is open, and never before', async () => {
    const { app, store, base, id, human } = await heldGame();
    const seen = () => human.messages.filter((m): m is Extract<ServerMessage, { type: 'hello' }> => m.type === 'hello');
    for (const m of seen()) expect(m.models).toBeUndefined();
    // play the game out as the human, answering everything
    const done = async () => {
      for (;;) {
        human.answerAll();
        if (getGame(store, id)!.status !== 'running') return;
        await new Promise((r) => setTimeout(r, 50));
      }
    };
    await Promise.race([done(), new Promise((r) => setTimeout(r, 60_000))]);
    await waitFor(() => seen().some((m) => m.lockOpen));
    const open = seen().filter((m) => m.lockOpen).at(-1)!;
    expect(open.models?.length).toBeGreaterThan(0);
    expect(open.models!.every((x) => typeof x.label === 'string' && x.label.length > 0)).toBe(true);
    void app;
    void base;
  }, 120_000);
});

describe('a game that is not running here any more (§9.4)', () => {
  it('is shown read-only, and one that could not be recovered can still be aborted', async () => {
    const store = openStore(':memory:', { migrationsDir: MIGRATIONS_DIR });
    const { app, id } = await heldGame({ store });
    await app.close();
    running.length = 0;
    // a restart where the game is not recovered (as for a corrupt one)
    const second = await listening(store);
    const host = new Holder(second.base, id);
    await host.connect(`${HOST_COOKIE}=${HOST}`);
    await waitFor(() => host.messages.some((m) => m.type === 'hello'));
    expect(host.messages.some((m) => m.type === 'lobby_state')).toBe(false); // not a lobby editor
    const hello = host.messages.find((m): m is Extract<ServerMessage, { type: 'hello' }> => m.type === 'hello')!;
    expect(hello.entries.length).toBeGreaterThan(0);
    const res = await second.app.inject({ method: 'POST', url: `/api/games/${id}/abort`, headers: asHost });
    expect(res.statusCode).toBe(200);
    expect(getGame(store, id)!.status).toBe('aborted');
    host.close();
  }, 60_000);
});

describe('host "fallback now" (§9.3)', () => {
  it('reveals no count at night, and is applied once the game is out of the night', async () => {
    // short human timeouts so the night itself resolves quickly; the fallback must still wait
    const { app, store, id, human } = await heldGame({
      app: { pauseOnAllHumansDisconnected: false },
      // 5 s is the lowest the rules allow; the night resolves on its own while the host waits
      rules: { human_timeouts: { long_text_ms: 5_000, channel_ms: 5_000, other_ms: 5_000 } },
    });
    const seat = seatOfSlot(store, id, 1);
    expect(human.requests[0]!.context).toBeTruthy();
    human.close();
    await new Promise((r) => setTimeout(r, 150));

    const res = await app.inject({ method: 'POST', url: `/api/games/${id}/fallback-now`, headers: asHost, payload: { target: 'disconnected' } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { applied?: number; deferred?: boolean };
    expect(body.applied).toBeUndefined(); // §9.3: no count while the game is still hidden
    expect(body.deferred).toBe(true);
    // the night runs its own course, and the first day request of that seat is forced
    await waitFor(() => listDecisions(store, id).some((d) => d.seat === seat && d.answer.kind === 'no_answer' && d.answer.reason === 'forced'), 40_000);
    const forced = listDecisions(store, id).filter((d) => d.seat === seat && d.answer.kind === 'no_answer' && d.answer.reason === 'forced');
    expect(forced.length).toBeGreaterThan(0);
    // and it only happened after the night was over
    const day = listEngineEvents(store, id).some((e) => e.type === 'PHASE_START' && (e.payload as { phase: string }).phase === 'day');
    expect(day).toBe(true);
  }, 90_000);
});

describe('client-sdk', () => {
  it('keeps one feed per scope, so host-player mode does not mix them up', () => {
    let s = emptyState();
    const hostHello: ServerMessage = {
      type: 'hello',
      scope: 'host',
      principal: { kind: 'host' },
      gameId: 'g',
      status: 'running',
      lockOpen: false,
      view: null,
      entries: [{ vseq: 1, at: { phase: 'night', day: 0, night: 1 }, type: 'PHASE_START', payload: {} }],
      lastVseq: 1,
      pending: null,
    };
    const seatHello: ServerMessage = { ...hostHello, scope: 'seat', principal: { kind: 'seat', seat: 3, slot: 3, name: 'Cora' }, entries: [], lastVseq: 0 };
    s = applyMessage(s, hostHello).state;
    s = applyMessage(s, seatHello).state;
    expect(s.scopes.host.lastVseq).toBe(1);
    expect(s.scopes.seat.lastVseq).toBe(0);
    expect(s.scopes.seat.principal).toMatchObject({ kind: 'seat', seat: 3 });

    // host entries must not land in the seat feed
    s = applyMessage(s, { type: 'entries', scope: 'host', fromVseq: 1, entries: [{ vseq: 2, at: { phase: 'day', day: 1, night: 1 }, type: 'PHASE_START', payload: {} }] }).state;
    expect(s.scopes.host.entries).toHaveLength(2);
    expect(s.scopes.seat.entries).toHaveLength(0);

    // a gap asks for a resync
    const gap = applyMessage(s, { type: 'entries', scope: 'seat', fromVseq: 5, entries: [] });
    expect(gap.needsResync).toBe(true);
  });
});

function seatOfSlot(store: Store, gameId: string, slot: number): number {
  const seating = listEngineEvents(store, gameId).find((e) => e.type === 'SEATING')!;
  return (seating.payload as { seats: { seat: number; slot: number }[] }).seats.find((s) => s.slot === slot)!.seat;
}

async function waitForValue<T>(get: () => T | undefined, timeoutMs = 20_000): Promise<T> {
  await waitFor(() => get() !== undefined, timeoutMs);
  return get()!;
}

async function waitFor(check: () => boolean, timeoutMs = 20_000): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (check()) return;
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for the condition');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('everyone left, then came back (§9.3)', () => {
  it('pauses when the last human drops and picks itself up when they return', async () => {
    const { app, store, base, id, human } = await heldGame({ app: { disconnectMaxMs: 60_000 } });
    void app;
    human.close();
    await waitFor(() => getGame(store, id)!.status === 'paused' && getGame(store, id)!.pause_reason === 'humans_disconnected', 15_000);
    const back = new Holder(base, id);
    back.cookie = human.cookie;
    await back.connect();
    await waitFor(() => getGame(store, id)!.status !== 'paused', 15_000);
    expect(getGame(store, id)!.pause_reason).toBeNull();
    // and they can carry on playing
    await waitFor(() => back.requests.length > 0, 15_000);
    back.answerAll();
    await waitFor(() => listDecisions(store, id).length > 0, 15_000);
  }, 90_000);
});

/** A raw socket for the cases where the server is expected to refuse or answer one message. */
function rawSocket(base: string, gameId: string, cookie: string): Promise<{ ws: WebSocket; messages: ServerMessage[]; closed: Promise<{ code: number; reason: string }> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws?game=${gameId}`, { headers: { cookie } } as unknown as string[]);
    const messages: ServerMessage[] = [];
    let closedResolve: (v: { code: number; reason: string }) => void = () => undefined;
    const closed = new Promise<{ code: number; reason: string }>((r) => (closedResolve = r));
    ws.addEventListener('message', (ev: MessageEvent) => messages.push(JSON.parse(String(ev.data)) as ServerMessage));
    ws.addEventListener('close', (ev: CloseEvent) => closedResolve({ code: ev.code, reason: ev.reason }));
    ws.addEventListener('open', () => resolve({ ws, messages, closed }));
    ws.addEventListener('error', () => reject(new Error('socket error')));
  });
}

describe('M6 review round 3', () => {
  it('a forced start shuts out the missing player: their link and their cookie open nothing', async () => {
    const { app, store, base } = await listening();
    const created = await app.inject({ method: 'POST', url: '/api/lobbies', headers: asHost, payload: { compositionId: 'classic-7', aliases: ['glm-flash', 'deepseek-flash'] } });
    const { id, draft } = created.json() as { id: string; draft: { slots: { slot: number; controller: string; alias: string | null; humanName: string | null }[] } };
    const slots = draft.slots.map((x) => (x.slot === 1 || x.slot === 2 ? { ...x, controller: 'human', alias: null, humanName: `P${x.slot}` } : x));
    await app.inject({ method: 'PATCH', url: `/api/lobbies/${id}`, headers: asHost, payload: { slots } });
    const links = (await app.inject({ method: 'POST', url: `/api/lobbies/${id}/links`, headers: asHost })).json() as { seats: { slot: number; url: string }[] };
    const tokenOf = (slot: number) => links.seats.find((x) => x.slot === slot)!.url.split('/').at(-1)!;

    // slot 1 opens their link and then goes away before the start; slot 2 never opens theirs
    const joined = await fetch(`${base}/join/${tokenOf(1)}`);
    const cookie = (joined.headers.getSetCookie?.() ?? [])[0]!.split(';')[0]!;
    const started = await app.inject({ method: 'POST', url: `/api/lobbies/${id}/start`, headers: asHost, payload: { force: true } });
    expect(started.statusCode).toBe(200);
    await waitFor(() => getGame(store, id)!.status !== 'lobby');

    // the unopened link is dead: it would otherwise hand over the model's seat (§9.1)
    expect((await app.inject({ method: 'GET', url: `/join/${tokenOf(2)}` })).statusCode).toBe(404);
    // and the cookie of the player who left no longer opens the seat either
    const late = await rawSocket(base, id, cookie);
    const closed = await late.closed;
    expect(closed.code).toBe(1008);
    expect(closed.reason).toContain('given to a model');
    expect(late.messages.some((m) => m.type === 'hello')).toBe(false);
  }, 60_000);

  it('a game that is not running here can be aborted from the host screen (over the socket)', async () => {
    const store = openStore(':memory:', { migrationsDir: MIGRATIONS_DIR });
    const { app, id } = await heldGame({ store });
    await app.close();
    running.length = 0;
    const second = await listening(store);
    const host = await rawSocket(second.base, id, `${HOST_COOKIE}=${HOST}`);
    await waitFor(() => host.messages.some((m) => m.type === 'host_status'));
    const status = host.messages.find((m): m is Extract<ServerMessage, { type: 'host_status' }> => m.type === 'host_status')!;
    expect(status.pauseReason).toBe('not_loaded');
    host.ws.send(JSON.stringify({ type: 'host_command', scope: 'host', command: { cmd: 'abort' } }));
    const result = await waitForValue(() => host.messages.find((m): m is Extract<ServerMessage, { type: 'command_result' }> => m.type === 'command_result'));
    expect(result.ok).toBe(true);
    expect(getGame(store, id)!.status).toBe('aborted');
    host.ws.close();
  }, 60_000);

  it('a player’s own answer is acknowledged, not reported as "closed without you"', async () => {
    const { human } = await heldGame();
    const open = human.requests[0]!;
    human.answerAll();
    await waitFor(() => human.messages.some((m) => m.type === 'decision_accepted' && m.clientRequestId === open.clientRequestId));
    expect(human.messages.some((m) => m.type === 'decision_closed' && m.clientRequestId === open.clientRequestId)).toBe(false);
  }, 60_000);

  it('raising the cap does not undo a pause the host chose', async () => {
    const { app, store, id } = await heldGame();
    await app.inject({ method: 'POST', url: `/api/games/${id}/pause`, headers: asHost });
    await waitFor(() => getGame(store, id)!.status === 'paused');
    const raised = await app.inject({ method: 'POST', url: `/api/games/${id}/raise-cap`, headers: asHost, payload: { capUsd: 9 } });
    expect(raised.statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 200));
    expect(getGame(store, id)!.status).toBe('paused');
  }, 60_000);

  it('every host command gets an answer in words', async () => {
    const { base, id } = await heldGame();
    const host = await rawSocket(base, id, `${HOST_COOKIE}=${HOST}`);
    // at night, while the game is hidden, settling a vote is refused in words, not silently
    host.ws.send(JSON.stringify({ type: 'host_command', scope: 'host', command: { cmd: 'fallback_now', target: 'all_ballots' } }));
    const result = await waitForValue(() => host.messages.find((m): m is Extract<ServerMessage, { type: 'command_result' }> => m.type === 'command_result'));
    expect(result.message.length).toBeGreaterThan(5);
    host.ws.close();
  }, 60_000);

  it('the host status names the people (by slot), never their seats', async () => {
    const { base, id } = await heldGame();
    const host = await rawSocket(base, id, `${HOST_COOKIE}=${HOST}`);
    const status = await waitForValue(() => host.messages.find((m): m is Extract<ServerMessage, { type: 'host_status' }> => m.type === 'host_status'));
    expect(status.humans).toEqual([{ slot: 1, name: 'Nadia', connected: true }]);
    host.ws.close();
  }, 60_000);

  it('the host can sign in from another device with the token, and only with it', async () => {
    const { app } = await listening();
    const wrong = await app.inject({ method: 'POST', url: '/api/host/login', payload: { token: 'nope' } });
    expect(wrong.statusCode).toBe(401);
    const right = await app.inject({ method: 'POST', url: '/api/host/login', payload: { token: HOST } });
    expect(right.statusCode).toBe(200);
    const cookie = String(right.headers['set-cookie']);
    expect(cookie).toContain(`${HOST_COOKIE}=`);
    expect(cookie).toContain('HttpOnly');
    // the cookie alone now makes a request the host's
    const games = await app.inject({ method: 'GET', url: '/api/rosters', headers: { cookie: cookie.split(';')[0]! } });
    expect(games.statusCode).toBe(200);
  }, 60_000);

  it('the debrief offer leaves the host screen as soon as it is answered', async () => {
    const { app, store, base } = await listening();
    const created = await app.inject({ method: 'POST', url: '/api/lobbies', headers: asHost, payload: { compositionId: 'classic-7', aliases: ['glm-flash'] } });
    const { id } = created.json() as { id: string };
    await app.inject({ method: 'POST', url: `/api/lobbies/${id}/start`, headers: asHost, payload: {} });
    await waitFor(() => getGame(store, id)!.status === 'over_offer', 60_000);
    const host = await rawSocket(base, id, `${HOST_COOKIE}=${HOST}`);
    await waitFor(() => host.messages.some((m) => m.type === 'host_status' && m.debriefPending));
    const before = host.messages.length;
    host.ws.send(JSON.stringify({ type: 'host_command', scope: 'host', command: { cmd: 'debrief', open: true } }));
    await waitFor(() => host.messages.slice(before).some((m) => m.type === 'host_status' && !m.debriefPending));
    host.ws.close();
  }, 90_000);
});

describe('M6 review round 4', () => {
  /** A lobby with slots 1 and 2 played by people, and their links. */
  async function twoHumanLobby() {
    const { app, store, base } = await listening();
    const created = await app.inject({ method: 'POST', url: '/api/lobbies', headers: asHost, payload: { compositionId: 'classic-7', aliases: ['glm-flash', 'deepseek-flash'] } });
    const { id, draft } = created.json() as { id: string; draft: { slots: { slot: number; controller: string; alias: string | null; humanName: string | null }[] } };
    const slots = draft.slots.map((x) => (x.slot <= 2 ? { ...x, controller: 'human', alias: null, humanName: `P${x.slot}` } : x));
    await app.inject({ method: 'PATCH', url: `/api/lobbies/${id}`, headers: asHost, payload: { slots } });
    const links = (await app.inject({ method: 'POST', url: `/api/lobbies/${id}/links`, headers: asHost })).json() as { seats: { slot: number; url: string }[] };
    const tokenOf = (slot: number) => links.seats.find((x) => x.slot === slot)!.url.split('/').at(-1)!;
    return { app, store, base, id, slots, tokenOf };
  }

  it('once the game has started, the host cannot mint fresh seat links (that would bypass the rejoin code)', async () => {
    const { app, id } = await heldGame();
    const res = await app.inject({ method: 'POST', url: `/api/lobbies/${id}/links`, headers: asHost });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toContain('More host tools');
  }, 60_000);

  it('a seat the host hands to a model in the lobby shuts out its player at once, and after the start', async () => {
    const { app, base, id, slots, tokenOf } = await twoHumanLobby();
    const joined = await fetch(`${base}/join/${tokenOf(2)}`);
    const cookie = (joined.headers.getSetCookie?.() ?? [])[0]!.split(';')[0]!;
    const player = await rawSocket(base, id, cookie);
    // the host gives slot 2 back to a model
    const back = slots.map((x) => (x.slot === 2 ? { ...x, controller: 'ai', alias: 'glm-flash', humanName: null } : x));
    await app.inject({ method: 'PATCH', url: `/api/lobbies/${id}`, headers: asHost, payload: { slots: back } });
    const closed = await player.closed;
    expect(closed.code).toBe(1008);
    expect(closed.reason).toContain('gave your seat to a model');
    // the cookie opens nothing any more, before or after the start
    const again = await rawSocket(base, id, cookie);
    expect((await again.closed).code).toBe(1008);
    await app.inject({ method: 'POST', url: `/api/lobbies/${id}/start`, headers: asHost, payload: { force: true } });
    const late = await rawSocket(base, id, cookie);
    expect((await late.closed).code).toBe(1008);
    expect(late.messages.some((m) => m.type === 'hello')).toBe(false);
  }, 60_000);

  it('a reissued seat tells the old device why it was shut out', async () => {
    const { app, base, id, human } = await heldGame();
    const oldCookie = human.cookie;
    human.close();
    await new Promise((r) => setTimeout(r, 150));
    // the game is still hidden, so the reissue needs the code the player got on their own device
    const res = await app.inject({ method: 'POST', url: `/api/games/${id}/reissue-link`, headers: asHost, payload: { slot: 1, rejoinCode: human.rejoinCode } });
    expect(res.statusCode).toBe(200);
    const stale = await rawSocket(base, id, oldCookie);
    const closed = await stale.closed;
    expect(closed.code).toBe(1008);
    expect(closed.reason).toContain('moved to another device');
  }, 60_000);

  it('a spectator link can be opened by many people, and asking for one leaves the seat links alone', async () => {
    const { app, id, tokenOf } = await twoHumanLobby();
    const spec = (await app.inject({ method: 'POST', url: `/api/games/${id}/spectator-link`, headers: asHost })).json() as { url: string };
    const token = spec.url.split('/').at(-1)!;
    expect((await app.inject({ method: 'GET', url: `/spectate/${token}` })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/spectate/${token}` })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/join/${tokenOf(1)}` })).statusCode).toBe(200);
  }, 60_000);

  it('the games list needs a real session, not just a cookie with the right name', async () => {
    const { app } = await listening();
    const fake = await app.inject({ method: 'GET', url: '/api/games', headers: { cookie: 'ww_seat_x=1' } });
    expect(fake.statusCode).toBe(401);
  }, 60_000);

  it('a lobby that never started can be discarded; a started game cannot', async () => {
    const { app, store, id } = await twoHumanLobby();
    expect((await app.inject({ method: 'POST', url: `/api/lobbies/${id}/discard`, headers: asHost })).statusCode).toBe(200);
    expect(getGame(store, id)).toBeUndefined();
    const held = await heldGame();
    expect((await held.app.inject({ method: 'POST', url: `/api/lobbies/${held.id}/discard`, headers: asHost })).statusCode).toBe(400);
  }, 60_000);

  it('guessing rejoin codes is stopped after a few wrong tries', async () => {
    const { app, id, human } = await heldGame();
    human.close();
    await new Promise((r) => setTimeout(r, 150));
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await app.inject({ method: 'POST', url: `/api/games/${id}/reissue-link`, headers: asHost, payload: { slot: 1, rejoinCode: `00000${i}` } })).statusCode);
    expect(codes.slice(0, 5).every((c) => c === 400)).toBe(true);
    expect(codes[5]).toBe(429);
  }, 60_000);

  it('a request carries its full clock, so the bar keeps its scale after a reload', async () => {
    const { human } = await heldGame();
    expect(human.requests[0]!.totalMs).toBeGreaterThan(0);
  }, 60_000);

  it('"settle the current turn" answers truthfully: refused at night, done by day (without a count) while hidden', async () => {
    const { base, id, human } = await heldGame();
    const host = await rawSocket(base, id, `${HOST_COOKIE}=${HOST}`);
    const hello = await waitForValue(() => host.messages.find((m): m is Extract<ServerMessage, { type: 'hello' }> => m.type === 'hello'));
    const phase = (hello.view as { phase: string }).phase;
    host.ws.send(JSON.stringify({ type: 'host_command', scope: 'host', command: { cmd: 'fallback_now', target: 'current_speaker' } }));
    const r = await waitForValue(() => host.messages.find((m): m is Extract<ServerMessage, { type: 'command_result' }> => m.type === 'command_result'));
    if (phase === 'night') {
      expect(r.ok).toBe(false);
      expect(r.message).toContain('at night');
    } else {
      // by day it works, and the host is told so — never the night refusal, never a count
      expect(r.ok).toBe(true);
      expect(r.message).toBe('done');
      void human;
    }
    host.ws.close();
  }, 60_000);

  it('after a restart a player of a finished game gets their own card back, and everyone the models', async () => {
    const store = openStore(':memory:', { migrationsDir: MIGRATIONS_DIR });
    const { app, id, human } = await heldGame({ store });
    const cookie = human.cookie;
    const done = async () => {
      for (;;) {
        human.answerAll();
        if (!['running'].includes(getGame(store, id)!.status)) return;
        await new Promise((r) => setTimeout(r, 50));
      }
    };
    await Promise.race([done(), new Promise((r) => setTimeout(r, 60_000))]);
    await app.inject({ method: 'POST', url: `/api/games/${id}/abort`, headers: asHost }); // ends the debrief offer, keeps the result
    await waitFor(() => getGame(store, id)!.status === 'over');
    await app.close();
    running.length = 0;
    const second = await listening(store);
    const player = await rawSocket(second.base, id, cookie);
    await waitFor(() => player.messages.filter((m) => m.type === 'hello').length >= 2);
    const hellos = player.messages.filter((m): m is Extract<ServerMessage, { type: 'hello' }> => m.type === 'hello');
    expect(hellos.some((m) => m.principal.kind === 'seat')).toBe(true);
    expect(hellos.every((m) => (m.models?.length ?? 0) > 0)).toBe(true);
    player.ws.close();
  }, 120_000);
});

describe('M6 review round 5', () => {
  async function lobbyWithAlice() {
    const { app, store, base } = await listening();
    const created = await app.inject({ method: 'POST', url: '/api/lobbies', headers: asHost, payload: { compositionId: 'classic-7', aliases: ['glm-flash'] } });
    const { id, draft } = created.json() as { id: string; draft: { slots: { slot: number; controller: string; alias: string | null; humanName: string | null }[] } };
    const slots = draft.slots.map((x) => (x.slot === 1 ? { ...x, controller: 'human', alias: null, humanName: 'Alice' } : x));
    await app.inject({ method: 'PATCH', url: `/api/lobbies/${id}`, headers: asHost, payload: { slots } });
    const links = (await app.inject({ method: 'POST', url: `/api/lobbies/${id}/links`, headers: asHost })).json() as { seats: { slot: number; url: string }[] };
    return { app, store, base, id, token: links.seats[0]!.url.split('/').at(-1)! };
  }

  it('"New links" never gives a second device a seat a player already holds', async () => {
    const { app, base, id, token } = await lobbyWithAlice();
    const joined = await fetch(`${base}/join/${token}`);
    expect(joined.status).toBe(200);
    const again = (await app.inject({ method: 'POST', url: `/api/lobbies/${id}/links`, headers: asHost })).json() as { seats: { slot: number }[]; joined: number[] };
    expect(again.seats.some((x) => x.slot === 1)).toBe(false); // no second path onto Alice's seat
    expect(again.joined).toEqual([1]);
  }, 60_000);

  it('the host can move a joined player to a new link, which shuts the old device out', async () => {
    const { app, base, id, token } = await lobbyWithAlice();
    const first = await fetch(`${base}/join/${token}`);
    const cookie = (first.headers.getSetCookie?.() ?? [])[0]!.split(';')[0]!;
    const socket = await rawSocket(base, id, cookie);
    const res = await app.inject({ method: 'POST', url: `/api/lobbies/${id}/replace-link`, headers: asHost, payload: { slot: 1 } });
    expect(res.statusCode).toBe(200);
    const closed = await socket.closed;
    expect(closed.code).toBe(1008);
    const fresh = (res.json() as { url: string }).url.split('/').at(-1)!;
    expect((await fetch(`${base}/join/${fresh}`)).status).toBe(200);
    expect((await rawSocket(base, id, cookie).then((x) => x.closed)).code).toBe(1008);
  }, 60_000);

  it('after a restart, players who have not come back count as offline', async () => {
    const store = openStore(':memory:', { migrationsDir: MIGRATIONS_DIR });
    const { app, id } = await heldGame({ store });
    await app.close();
    running.length = 0;
    const second = await listening(store);
    await (second.app as unknown as { ww: { recoverAll: () => Promise<unknown[]> } }).ww.recoverAll();
    const host = await rawSocket(second.base, id, `${HOST_COOKIE}=${HOST}`);
    const st = await waitForValue(() => host.messages.find((m): m is Extract<ServerMessage, { type: 'host_status' }> => m.type === 'host_status'));
    expect(st.humans).toEqual([{ slot: 1, name: 'Nadia', connected: false }]);
    expect(st.disconnectedSlots).toEqual([1]);
    host.ws.close();
  }, 60_000);

  it('a reissue must name a real slot: "01" is not a way round the lockout', async () => {
    const { app, id } = await heldGame();
    const res = await app.inject({ method: 'POST', url: `/api/games/${id}/reissue-link`, headers: asHost, payload: { slot: '01', rejoinCode: 'ABCDEF' } });
    expect(res.statusCode).toBe(400);
  }, 60_000);

  it('notes longer than the limit are refused in words, and the socket stays open', async () => {
    const { human } = await heldGame();
    const before = human.messages.length;
    human.ws!.send(JSON.stringify({ type: 'notes_update', scope: 'seat', text: 'x'.repeat(4_001) }));
    await waitFor(() => human.messages.slice(before).some((m) => m.type === 'error'));
    expect(human.ws!.readyState).toBe(1);
  }, 60_000);

  it('a stale host cookie never costs the owner their rights on their own PC', async () => {
    const { app } = await listening(undefined, { hostFromLocalhost: true });
    const res = await app.inject({ method: 'GET', url: '/api/rosters', headers: { cookie: `${HOST_COOKIE}=an-old-token` } });
    expect(res.statusCode).toBe(200);
    // an explicit wrong token is still refused
    expect((await app.inject({ method: 'GET', url: '/api/rosters', headers: { 'x-host-token': 'wrong' } })).statusCode).toBe(401);
  }, 60_000);

  it('only the host lists the games', async () => {
    const { base, token } = await lobbyWithAlice();
    const joined = await fetch(`${base}/join/${token}`);
    const cookie = (joined.headers.getSetCookie?.() ?? [])[0]!.split(';')[0]!;
    expect((await fetch(`${base}/api/games`, { headers: { cookie } })).status).toBe(401);
  }, 60_000);

  it('a resume says where the game went back to', async () => {
    const { app, id, human } = await heldGame();
    await app.inject({ method: 'POST', url: `/api/games/${id}/pause`, headers: asHost });
    await app.inject({ method: 'POST', url: `/api/games/${id}/resume`, headers: asHost });
    const resumed = await waitForValue(() => human.messages.find((m): m is Extract<ServerMessage, { type: 'resumed' }> => m.type === 'resumed'));
    expect(resumed.status).toBe('running');
  }, 60_000);

  it('links point at a real network adapter, not a virtual one', () => {
    const fake = {
      'vEthernet (WSL)': [{ family: 'IPv4', internal: false, address: '172.28.16.1' }],
      'Wi-Fi': [{ family: 'IPv4', internal: false, address: '192.168.1.31' }],
      Loopback: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
    } as unknown as Parameters<typeof lanAddress>[0];
    expect(lanAddress(fake)).toBe('192.168.1.31');
  });
});

describe('the join page (review round 5)', () => {
  it('a browser opening a link gets a Join button, and only pressing it uses the link', async () => {
    const store = openStore(':memory:', { migrationsDir: MIGRATIONS_DIR });
    const app = await createServer({ env: { ...env, cfg: { ...env.cfg, app: { ...env.cfg.app, hostFromLocalhost: false } } }, store, hostToken: HOST, mock: true, webDir: join(ROOT, 'apps/web/public') });
    running.push({ app, store });
    const created = await app.inject({ method: 'POST', url: '/api/lobbies', headers: asHost, payload: { compositionId: 'classic-7', aliases: ['glm-flash'] } });
    const { id, draft } = created.json() as { id: string; draft: { slots: { slot: number; controller: string; alias: string | null; humanName: string | null }[] } };
    const slots = draft.slots.map((x) => (x.slot === 1 ? { ...x, controller: 'human', alias: null, humanName: 'Alice' } : x));
    await app.inject({ method: 'PATCH', url: `/api/lobbies/${id}`, headers: asHost, payload: { slots } });
    const links = (await app.inject({ method: 'POST', url: `/api/lobbies/${id}/links`, headers: asHost })).json() as { seats: { url: string }[] };
    const token = links.seats[0]!.url.split('/').at(-1)!;
    // a chat app drawing a preview fetches the page, twice even: the link survives
    for (let i = 0; i < 2; i++) {
      const preview = await app.inject({ method: 'GET', url: `/join/${token}`, headers: { accept: 'text/html' } });
      expect(preview.statusCode).toBe(200);
      expect(preview.body).toContain('Join the game');
    }
    // pressing the button uses it, and lands in the game with the rejoin code in the fragment
    const joined = await app.inject({ method: 'POST', url: `/join/${token}`, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: '' });
    expect(joined.statusCode).toBe(303);
    expect(String(joined.headers.location)).toMatch(/#rejoin=[0-9A-F]{6}$/);
    expect((await app.inject({ method: 'GET', url: `/join/${token}`, headers: { accept: 'text/html' } })).statusCode).toBe(404);
  }, 60_000);
});
