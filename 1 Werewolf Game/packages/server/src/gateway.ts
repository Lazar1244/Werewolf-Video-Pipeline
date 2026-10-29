import { randomUUID } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { z } from 'zod';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { MockProvider, OpenRouterClient, fetchCatalog, overrideEntry, parseModel, type CatalogEntry, type LLMProvider } from '@ww/llm';
import {
  ClientMessageSchema,
  HostCommandSchema,
  LobbyDraftSchema,
  LobbyPatchSchema,
  StartRequestSchema,
  BALANCE_BAND,
  validateComposition,
  type ClientRequest,
  type GameSnapshot,
  type Principal,
  type SeatId,
  type ServerMessage,
  type SlotId,
} from '@ww/shared';
import { abortGame as abortStoredGame, getCatalogEntry, getGame, listDecisions, listEngineEvents, putCatalogEntry, type Store } from '@ww/store';
import { HOST_COOKIE, anyLiveSession, checkHostToken, joinTokenUsable, originAllowed, redeemJoinToken, seatCookieName, sessionByCookie, slotOfAnyCookie, spectatorCookieName, type SessionRow } from './auth';
import { LobbyError, LobbyService } from './lobby';
import { GameOrchestrator, remapProblem, type PendingHuman } from './orchestrator';
import { resolveCatalog, type Env } from './setup';
import { entriesSince, hostSafeCost, viewFor } from './views';
import { modelStats, recoverGame, recoverableGames, roleStats } from './recovery';

export interface ServerOptions {
  env: Env;
  store: Store;
  hostToken: string | null;
  /** Directory of the built web UI; when set it is served at `/` (M6). */
  webDir?: string | null;
  /** Answer with the mock provider instead of calling OpenRouter (tests and dry runs). */
  mock?: boolean;
  logPrompts?: boolean;
}

/**
 * A room exists from the moment someone connects to a lobby; the orchestrator appears when the
 * game starts. Humans join the lobby first, which is how the start knows they are ready (§9.2).
 */
/**
 * The address other devices on the LAN can reach: a private (RFC 1918) IPv4 address on a real
 * adapter. Virtual adapters (WSL, Hyper-V, Docker, VPNs) are passed over, since a link pointing at
 * one would silently fail on every phone. `app.publicHost` pins it when the guess is wrong.
 */
export function lanAddress(interfaces = networkInterfaces()): string | null {
  const virtual = /vethernet|wsl|hyper-v|docker|virtualbox|vmware|vbox|tailscale|zerotier|utun|tun|tap|loopback|bridge|br-|veth/i;
  const privateV4 = (ip: string) => /^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
  const candidates: { name: string; address: string }[] = [];
  for (const [name, list] of Object.entries(interfaces)) for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) candidates.push({ name, address: a.address });
  const rank = (c: { name: string; address: string }) => (virtual.test(c.name) ? 2 : 0) + (privateV4(c.address) ? 0 : 1);
  return candidates.sort((a, b) => rank(a) - rank(b))[0]?.address ?? null;
}

/** An error as a person should read it: a schema error becomes "field: problem" lines, not JSON. */
function messageOf(e: unknown): string {
  const issues = (e as { issues?: { path: PropertyKey[]; message: string }[] }).issues;
  if (Array.isArray(issues) && issues.length) return issues.map((i) => `${i.path.map(String).join('.') || 'value'}: ${i.message}`).join('; ');
  return e instanceof Error ? e.message : String(e);
}

interface LiveGame {
  orchestrator: GameOrchestrator | null;
  sockets: Set<Socket>;
}

interface Socket {
  send(msg: ServerMessage): void;
  /** Close with a reason the browser shows (1008 means "do not come back with this cookie"). */
  close(code: number, reason: string): void;
  gameId: string;
  /** Highest vseq already sent, per scope. */
  sent: Map<string, number>;
  slot: SlotId | null;
  isHost: boolean;
  isSpectator: boolean;
  rate: { tokens: number; at: number };
}

const MAX_MESSAGE_BYTES = 16 * 1024;
/** A reissue request: a real slot number and, if given, a code of the right shape (§9.1). */
const ReissueBodySchema = z.strictObject({ slot: z.int().min(1).max(10), rejoinCode: z.string().regex(/^[0-9a-fA-F]{6}$/).optional() });

/** How often the server checks that a socket still answers; two missed checks close it. */
const HEARTBEAT_MS = 20_000;
/** Wrong rejoin codes allowed per seat before reissues for it are refused for a while. */
const REJOIN_TRIES = 5;
const REJOIN_LOCK_MS = 10 * 60_000;
/** Per-socket rate limit (§11.2): a burst, then a steady trickle. */
const RATE_BURST = 40;
const RATE_PER_SECOND = 10;

function allow(socket: Socket): boolean {
  const now = Date.now();
  const elapsed = (now - socket.rate.at) / 1000;
  socket.rate.at = now;
  socket.rate.tokens = Math.min(RATE_BURST, socket.rate.tokens + elapsed * RATE_PER_SECOND);
  if (socket.rate.tokens < 1) return false;
  socket.rate.tokens -= 1;
  return true;
}

export async function createServer(o: ServerOptions): Promise<FastifyInstance> {
  const app = Fastify({ bodyLimit: 1024 * 1024, logger: false });
  await app.register(cookie);
  await app.register(websocket, { options: { maxPayload: MAX_MESSAGE_BYTES } });
  // the "Join" button posts an empty HTML form: accept it (its body carries nothing we read)
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, _body, done) => done(null, {}));

  if (o.webDir) {
    await app.register(fastifyStatic, { root: o.webDir, index: ['index.html'] });
  }

  const lobbies = new LobbyService(o.env, o.store);
  const live = new Map<string, LiveGame>();

  const provider = (): LLMProvider =>
    o.mock
      ? new MockProvider({ seed: 11, costPerCall: 0.0004 })
      : new OpenRouterClient({
          baseUrl: o.env.cfg.app.openrouter.baseUrl,
          apiKey: o.env.apiKey ?? '',
          referer: o.env.cfg.app.openrouter.referer,
          title: o.env.cfg.app.openrouter.title,
          fetch: globalThis.fetch as never,
        });

  // ---- principals ---------------------------------------------------------------

  const isHost = (req: FastifyRequest): boolean => {
    const opts = { hostToken: o.hostToken, hostFromLocalhost: o.env.cfg.app.hostFromLocalhost };
    const header = req.headers['x-host-token'] as string | undefined;
    if (header !== undefined) return checkHostToken(opts, header, req.ip);
    // a cookie from before HOST_TOKEN was changed must not lock the owner out of their own PC
    const cookieToken = req.cookies[HOST_COOKIE];
    if (cookieToken && checkHostToken({ ...opts, hostFromLocalhost: false }, cookieToken, req.ip)) return true;
    return checkHostToken(opts, undefined, req.ip);
  };

  const requireHost = (req: FastifyRequest, reply: FastifyReply): boolean => {
    if (!originAllowed(req.headers.origin, req.headers.host)) {
      void reply.code(403).send({ error: 'bad origin' });
      return false;
    }
    if (!isHost(req)) {
      void reply.code(401).send({ error: 'host authentication required' });
      return false;
    }
    return true;
  };

  /**
   * The address to put in a link. A host who opened the page as `localhost` would otherwise hand
   * out links no other device can open, so the machine's LAN address is used instead.
   */
  const publicBase = (req: FastifyRequest): string => {
    const host = req.headers.host ?? `localhost:${o.env.cfg.app.port}`;
    const [name, port] = host.includes(']') ? [host.slice(0, host.indexOf(']') + 1), host.slice(host.indexOf(']') + 2)] : (host.split(':') as [string, string | undefined]);
    if (o.env.cfg.app.publicHost) return `${req.protocol}://${o.env.cfg.app.publicHost}`;
    if (!['localhost', '127.0.0.1', '[::1]'].includes(name)) return `${req.protocol}://${host}`;
    const lan = lanAddress();
    return lan ? `${req.protocol}://${lan}${port ? `:${port}` : ''}` : `${req.protocol}://${host}`;
  };

  /** What a request carries: host rights, a seat's slot, a spectator pass (they can combine). */
  const rightsOf = (req: FastifyRequest, gameId: string): { host: boolean; slot: SlotId | null; spectator: boolean; converted: boolean; reissued: boolean } => {
    const seatCookie = req.cookies[seatCookieName(gameId)];
    const session = seatCookie ? sessionByCookie(o.store, gameId, seatCookie) : undefined;
    const specCookie = req.cookies[spectatorCookieName(gameId)];
    const slot = (session?.slot ?? null) as SlotId | null;
    // After a forced start a missing player's slot belongs to a model: their cookie opens nothing
    // (the start also revoked it). Knowing the slot it was for lets the refusal say why.
    const issuedFor = seatCookie ? ((session?.slot ?? slotOfAnyCookie(o.store, gameId, seatCookie)) as SlotId | null) : null;
    const converted = issuedFor !== null && !slotIsHuman(gameId, issuedFor);
    // a revoked cookie of a seat that is still a person's: the host made that player a new link
    const reissued = !converted && issuedFor !== null && session === undefined;
    return {
      host: isHost(req),
      slot: converted || slot === null ? null : slot,
      spectator: !!specCookie && !!sessionByCookie(o.store, gameId, specCookie),
      converted,
      reissued,
    };
  };

  /**
   * Whether a lobby slot is played by a person: the frozen snapshot once the game has started,
   * the draft before. A seat is only ever granted to a cookie of a slot that is human now.
   */
  function slotIsHuman(gameId: string, slot: SlotId): boolean {
    const running = live.get(gameId)?.orchestrator;
    if (running) return running.isHumanSlot(slot);
    const row = o.store.db.prepare('SELECT controller FROM slots WHERE game_id = ? AND slot = ?').get(gameId, slot) as { controller: string } | undefined;
    if (row) return row.controller === 'human';
    try {
      return lobbies.get(gameId).slots.some((s) => s.slot === slot && s.controller === 'human');
    } catch {
      return false;
    }
  }

  /** Every principal a socket holds right now (a seat exists only once the game has started). */
  const principalsFor = (room: LiveGame, socket: Socket): Principal[] => {
    const out: Principal[] = [];
    if (socket.isHost) out.push({ kind: 'host' });
    // a seat only for a slot the game really gives to a person (a model's slot is never a seat here)
    if (socket.slot !== null && room.orchestrator && room.orchestrator.isHumanSlot(socket.slot)) {
      const seat = seatOfSlot(socket.gameId, socket.slot);
      if (seat !== null) out.push({ kind: 'seat', seat, slot: socket.slot, name: nameOfSeat(socket.gameId, seat) });
    }
    // Once no human can act, a player sees what a spectator sees (ruleset §15,
    // `dead_human_spectates`); their own seat feed stays, for their card and notes.
    const openToPlayer = socket.slot !== null && !!room.orchestrator?.lockOpen && room.orchestrator.isHumanSlot(socket.slot);
    if (socket.isSpectator || openToPlayer) out.push({ kind: 'spectator' });
    return out;
  };

  const principalsOf = (req: FastifyRequest, gameId: string): Principal[] => {
    const rights = rightsOf(req, gameId);
    const room = live.get(gameId);
    const out: Principal[] = [];
    if (rights.host) out.push({ kind: 'host' });
    if (rights.slot !== null && room?.orchestrator) {
      const seat = seatOfSlot(gameId, rights.slot);
      if (seat !== null) out.push({ kind: 'seat', seat, slot: rights.slot, name: nameOfSeat(gameId, seat) });
    }
    if (rights.spectator) out.push({ kind: 'spectator' });
    return out;
  };

  /** True when the caller holds any session of any game on this server. */
  /** A device that holds a live session of some game (a cookie name alone proves nothing). */
  const anyGamePrincipal = (req: FastifyRequest): boolean =>
    anyLiveSession(
      o.store,
      Object.entries(req.cookies)
        .filter(([name, value]) => (name.startsWith('ww_seat_') || name.startsWith('ww_spec_')) && typeof value === 'string')
        .map(([, value]) => value as string),
    );

  /** The game's events: the live game's, or the stored ones for a game that is not running here. */
  const eventsOf = (gameId: string) => live.get(gameId)?.orchestrator?.events ?? listEngineEvents(o.store, gameId);

  const seatOfSlot = (gameId: string, slot: number | null): number | null => {
    if (slot === null) return null;
    const seating = eventsOf(gameId).find((e) => e.type === 'SEATING');
    if (!seating) return null;
    return (seating.payload as { seats: { seat: number; slot: number }[] }).seats.find((s) => s.slot === slot)?.seat ?? null;
  };

  const nameOfSeat = (gameId: string, seat: number): string => {
    const start = eventsOf(gameId).find((e) => e.type === 'GAME_START');
    if (!start) return `seat ${seat}`;
    return (start.payload as { seats: { seat: number; name: string }[] }).seats.find((s) => s.seat === seat)?.name ?? `seat ${seat}`;
  };

  // ---- REST: lobby options -------------------------------------------------------

  /**
   * What each model costs, in dollars per million input and output tokens, for the host choosing
   * models. From OpenRouter's catalogue (one request, then kept for six hours and saved to the
   * store's catalogue cache); in a dry run (`--mock`) and when OpenRouter cannot be reached,
   * from that cache or the profile's own `pricingOverride`. A model with no known price says so.
   */
  let priceList: { at: number; byAlias: Map<string, { inPerM: number; outPerM: number }> } | null = null;
  async function modelPrices(): Promise<Map<string, { inPerM: number; outPerM: number }>> {
    if (priceList && Date.now() - priceList.at < 6 * 3_600_000) return priceList.byAlias;
    let live: Map<string, CatalogEntry> | null = null;
    if (!o.mock) {
      try {
        const all = await fetchCatalog({ baseUrl: o.env.cfg.app.openrouter.baseUrl, apiKey: o.env.apiKey, fetch: globalThis.fetch as never, timeoutMs: 10_000 });
        live = new Map(all.map((e) => [e.id, e]));
      } catch {
        // offline: the cache below still answers for the models that have been played
      }
    }
    const byAlias = new Map<string, { inPerM: number; outPerM: number }>();
    for (const p of o.env.cfg.profiles) {
      let e: CatalogEntry | null = live?.get(p.openrouterId) ?? null;
      // remember it for a dry run, but never overwrite what a game already cached (with its endpoint prices)
      if (e && !getCatalogEntry(o.store, p.openrouterId)) putCatalogEntry(o.store, p.openrouterId, { id: e.id, context_length: e.contextLength, pricing: { prompt: String(e.pricing.prompt), completion: String(e.pricing.completion) }, supported_parameters: e.supportedParameters });
      if (!e) {
        const row = getCatalogEntry(o.store, p.openrouterId);
        if (row) {
          try {
            e = parseModel(row.data);
          } catch {
            e = null;
          }
        }
      }
      e ??= overrideEntry(p);
      if (e && (e.pricing.prompt > 0 || e.pricing.completion > 0)) byAlias.set(p.alias, { inPerM: e.pricing.prompt * 1e6, outPerM: e.pricing.completion * 1e6 });
    }
    // a failed look-up is retried soon; a good one is kept for a while
    priceList = { at: live ? Date.now() : Date.now() - 6 * 3_600_000 + 5 * 60_000, byAlias };
    return byAlias;
  }

  app.get('/api/models', async (req, reply) => {
    if (!requireHost(req, reply)) return;
    const prices = await modelPrices();
    await reply.send({
      profiles: o.env.cfg.profiles.map((p) => {
        const price = prices.get(p.alias);
        return { alias: p.alias, label: p.label, enabled: p.enabled, inPerM: price?.inPerM ?? null, outPerM: price?.outPerM ?? null };
      }),
    });
  });
  app.get('/api/rosters', (req, reply) => {
    if (!requireHost(req, reply)) return;
    void reply.send({ rosters: o.env.cfg.rosters });
  });
  app.get('/api/compositions', (req, reply) => {
    if (!requireHost(req, reply)) return;
    // every mode with what the gallery shows: its story, its tags, and its balance (§12.2)
    void reply.send({
      compositions: [...o.env.cfg.compositions.values()].map((c) => {
        const report = validateComposition(c, o.env.cfg.rules.reveal_on_death);
        return {
          id: c.id,
          label: c.label,
          category: c.category ?? 'custom',
          seats: c.seats,
          cards: c.cards,
          description: c.description ?? null,
          tags: c.tags ?? [],
          weight: report.weight,
          ...(report.weightRange ? { weightRange: report.weightRange } : {}),
          band: BALANCE_BAND,
        };
      }),
    });
  });
  app.get('/api/rules/default', (req, reply) => {
    if (!requireHost(req, reply)) return;
    void reply.send(o.env.cfg.rules);
  });

  // ---- REST: lobbies -------------------------------------------------------------

  app.post('/api/lobbies', async (req, reply) => {
    if (!requireHost(req, reply)) return;
    // manual: a custom game, where the host seats the players and deals the cards
    const body = req.body as { compositionId?: string; aliases?: string[]; draft?: unknown; manual?: boolean };
    try {
      const draft = body.draft ? LobbyDraftSchema.parse(body.draft) : lobbies.defaultDraft(body.compositionId ?? 'classic-7', body.aliases, body.manual === true);
      const id = lobbies.create(draft);
      await reply.send({ id, draft: lobbies.get(id) });
    } catch (e) {
      await reply.code(400).send({ error: messageOf(e) });
    }
  });

  app.get('/api/lobbies/:id', (req, reply) => {
    if (!requireHost(req, reply)) return;
    try {
      void reply.send({ draft: lobbies.get((req.params as { id: string }).id) });
    } catch (e) {
      void reply.code(404).send({ error: messageOf(e) });
    }
  });

  app.patch('/api/lobbies/:id', async (req, reply) => {
    if (!requireHost(req, reply)) return;
    try {
      const id = (req.params as { id: string }).id;
      const draft = lobbies.patch(id, LobbyPatchSchema.parse(req.body));
      // a slot given to a model (or a bot) must not stay reachable through its old link or socket
      const gone = new Set(lobbies.revokeNonHuman(id));
      const room = live.get(id);
      if (room) {
        for (const s of [...room.sockets]) if (s.slot !== null && gone.has(s.slot)) s.close(1008, 'the host gave your seat to a model');
        broadcastLobby(room, id);
      }
      await reply.send({ draft });
    } catch (e) {
      await reply.code(400).send({ error: messageOf(e) });
    }
  });

  app.get('/api/lobbies/:id/estimate', async (req, reply) => {
    if (!requireHost(req, reply)) return;
    try {
      await reply.send(await lobbies.estimate((req.params as { id: string }).id));
    } catch (e) {
      await reply.code(400).send({ error: messageOf(e) });
    }
  });

  app.post('/api/lobbies/:id/links', async (req, reply) => {
    if (!requireHost(req, reply)) return;
    const id = (req.params as { id: string }).id;
    const base = publicBase(req);
    try {
      const links = lobbies.issueLinks(id, base);
      const room = live.get(id);
      if (room) broadcastLobby(room, id); // the host's lobby learns which links are now out
      await reply.send(links);
    } catch (e) {
      await reply.code(400).send({ error: messageOf(e) });
    }
  });

  /**
   * The host on another device proves itself once with HOST_TOKEN; the browser then keeps an
   * HttpOnly cookie. From this machine no token is needed (`hostFromLocalhost`).
   */
  app.post('/api/host/login', async (req, reply) => {
    if (!originAllowed(req.headers.origin, req.headers.host)) {
      await reply.code(403).send({ error: 'bad origin' });
      return;
    }
    const token = String(((req.body ?? {}) as { token?: unknown }).token ?? '').trim();
    if (!token || !checkHostToken({ hostToken: o.hostToken, hostFromLocalhost: false }, token, req.ip)) {
      await reply.code(401).send({ error: 'that is not the host token' });
      return;
    }
    await reply.setCookie(HOST_COOKIE, token, { httpOnly: true, sameSite: 'strict', path: '/', secure: false }).send({ ok: true });
  });

  /** A spectator link at any time (lobby or game), shareable, never touching the seat links. */
  app.post('/api/games/:id/spectator-link', async (req, reply) => {
    if (!requireHost(req, reply)) return;
    try {
      await reply.send(lobbies.spectatorLink((req.params as { id: string }).id, publicBase(req)));
    } catch (e) {
      await reply.code(400).send({ error: messageOf(e) });
    }
  });

  /** In the lobby: replace one player's link, shutting out the device that joined with the old one. */
  app.post('/api/lobbies/:id/replace-link', async (req, reply) => {
    if (!requireHost(req, reply)) return;
    const id = (req.params as { id: string }).id;
    const slot = Number(((req.body ?? {}) as { slot?: unknown }).slot);
    try {
      if (!Number.isInteger(slot) || slot < 1 || slot > 10) throw new LobbyError('slot must be a number from 1 to 10');
      const issued = lobbies.replaceLobbyLink(id, slot as SlotId, publicBase(req));
      const room = live.get(id);
      if (room) {
        for (const s of [...room.sockets]) if (s.slot === slot && !s.isHost) s.close(1008, 'the host made you a new link: use that one');
        broadcastLobby(room, id);
      }
      await reply.send(issued);
    } catch (e) {
      await reply.code(400).send({ error: messageOf(e) });
    }
  });

  /** Throw away a lobby that never started. */
  app.post('/api/lobbies/:id/discard', async (req, reply) => {
    if (!requireHost(req, reply)) return;
    const id = (req.params as { id: string }).id;
    try {
      lobbies.discard(id);
      const room = live.get(id);
      if (room) for (const s of [...room.sockets]) s.close(1008, 'the host closed this lobby');
      live.delete(id);
      await reply.send({ ok: true });
    } catch (e) {
      await reply.code(400).send({ error: messageOf(e) });
    }
  });

  /** Wrong rejoin codes per seat: a code is 6 hex characters, so guessing must be made slow. */
  const rejoinFailures = new Map<string, { count: number; until: number }>();

  app.post('/api/games/:id/reissue-link', async (req, reply) => {
    if (!requireHost(req, reply)) return;
    const id = (req.params as { id: string }).id;
    const parsed = ReissueBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      await reply.code(400).send({ error: messageOf(parsed.error) });
      return;
    }
    const body = parsed.data;
    const base = publicBase(req);
    const key = `${id}:${body.slot}`;
    const locked = rejoinFailures.get(key);
    if (locked && locked.until > Date.now()) {
      await reply.code(429).send({ error: 'too many wrong rejoin codes for this seat: try again in a few minutes' });
      return;
    }
    try {
      if (!body.slot) throw new LobbyError('slot is required');
      const room = live.get(id);
      const lockOpen = room?.orchestrator?.lockOpen ?? false;
      const connected = [...(room?.sockets ?? [])].some((s) => s.slot === body.slot);
      let issued: { url: string };
      try {
        issued = lobbies.reissueSeatLink(id, body.slot as SlotId, base, { lockOpen, connected, ...(body.rejoinCode ? { rejoinCode: body.rejoinCode } : {}) });
      } catch (e) {
        if (messageOf(e).includes('does not match')) {
          const f = rejoinFailures.get(key) ?? { count: 0, until: 0 };
          f.count += 1;
          if (f.count >= REJOIN_TRIES) {
            f.until = Date.now() + REJOIN_LOCK_MS;
            f.count = 0;
          }
          rejoinFailures.set(key, f);
        }
        throw e;
      }
      rejoinFailures.delete(key);
      await reply.send(issued);
    } catch (e) {
      await reply.code(400).send({ error: messageOf(e) });
    }
  });

  app.post('/api/lobbies/:id/start', async (req, reply) => {
    if (!requireHost(req, reply)) return;
    const id = (req.params as { id: string }).id;
    try {
      const opts = StartRequestSchema.parse(req.body ?? {});
      const connected = [...(live.get(id)?.sockets ?? [])].map((s) => s.slot).filter((s): s is SlotId => s !== null);
      const room = live.get(id) ?? { orchestrator: null, sockets: new Set<Socket>() };
      const started = await lobbies.start(id, { ...opts, connectedSlots: connected, mock: o.mock });
      const game = new GameOrchestrator({
        store: o.store,
        gameId: id,
        snapshot: started.snapshot,
        pack: o.env.pack,
        app: o.env.cfg.app,
        provider: provider(),
        entries: started.entries,
        profilesByAlias: o.env.cfg.profilesByAlias,
        logPrompts: o.logPrompts ?? false,
      });
      room.orchestrator = game;
      live.set(id, room);
      wire(room);
      // the game's first events (its seating) are what map each slot to a seat, so it runs first;
      // a socket gets no entries before its snapshot (see pushEntries)
      void game.run().catch((e: unknown) => {
        app.log.error(e);
        broadcast(room, { type: 'error', message: messageOf(e) });
      });
      // the game now has seats, so every connected human is registered and gets a snapshot; a
      // socket on a slot that went to a model is shut out, with the reason
      for (const s of [...room.sockets]) {
        if (s.slot !== null && !game.isHumanSlot(s.slot)) {
          if (s.isHost || s.isSpectator) s.slot = null;
          else {
            s.close(1008, 'the game started without you, so your seat was given to a model');
            continue;
          }
        }
        if (s.slot !== null) game.humanConnected(s.slot);
        for (const p of principalsFor(room, s)) s.send(hello(room, s, p));
      }
      await reply.send({ gameId: id, warnings: started.warnings });
    } catch (e) {
      await reply.code(e instanceof LobbyError ? 400 : 500).send({ error: messageOf(e) });
    }
  });

  // ---- REST: games ---------------------------------------------------------------

  app.get('/api/games', (req, reply) => {
    // the host's list of games: players and spectators have their own game and nothing else
    if (!isHost(req)) {
      void reply.code(401).send({ error: anyGamePrincipal(req) ? 'only the host can list games' : 'authentication required' });
      return;
    }
    const rows = o.store.db
      .prepare(`SELECT id, created_at, status, winner_team, lock_open, cost_cap_usd, cost_spent_usd, json_extract(lobby_json, '$.compositionId') AS composition_id FROM games ORDER BY created_at DESC LIMIT 50`)
      .all() as {
      id: string;
      created_at: string;
      status: string;
      lock_open: number;
      winner_team: string | null;
      cost_cap_usd: number;
      cost_spent_usd: number;
      composition_id: string | null;
    }[];
    // host-safe: no winner, and only the last Dawn/Dusk cost, while a game's lock is closed (§9.1)
    void reply.send({
      games: rows.map((r) => ({
        id: r.id,
        createdAt: r.created_at,
        status: r.status,
        composition: r.composition_id ? (o.env.cfg.compositions.get(r.composition_id)?.label ?? r.composition_id) : null,
        lockOpen: !!r.lock_open,
        winner: r.lock_open ? r.winner_team : null,
        costCapUsd: r.cost_cap_usd,
        costUsd: r.lock_open ? r.cost_spent_usd : hostSafeCost(costAtLastBoundary(r.id, listEngineEvents(o.store, r.id)), r.cost_cap_usd, false),
      })),
    });
  });

  app.get('/api/games/:id/view', (req, reply) => {
    const id = (req.params as { id: string }).id;
    const game = live.get(id);
    const principals = principalsOf(req, id);
    if (principals.length === 0) {
      void reply.code(401).send({ error: 'not a principal of this game' });
      return;
    }
    const asked = (req.query as { scope?: string }).scope;
    const principal = asked ? principals.find((p) => p.kind === asked) : principals[0];
    if (!principal) {
      void reply.code(403).send({ error: `this session does not hold the "${asked ?? ''}" scope` });
      return;
    }
    if (!game?.orchestrator) {
      void reply.code(404).send({ error: 'game is not running on this server' });
      return;
    }
    const lock = game.orchestrator.lockOpen;
    void reply.send({ ...viewFor(game.orchestrator.events, principal, lock), lockOpen: lock, status: game.orchestrator.status });
  });

  app.get('/api/games/:id/debrief', (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (principalsOf(req, id).length === 0) {
      void reply.code(401).send({ error: 'not a principal of this game' });
      return;
    }
    const game = live.get(id);
    if (!game?.orchestrator) {
      void reply.code(404).send({ error: 'unknown game' });
      return;
    }
    const comments = game.orchestrator.events.filter((e) => e.type === 'DEBRIEF_COMMENT').map((e) => e.payload);
    void reply.send({ comments, open: game.orchestrator.hostDebriefPending });
  });

  app.post('/api/games/:id/remap-seat', async (req, reply) => {
    if (!requireHost(req, reply)) return;
    const id = (req.params as { id: string }).id;
    const game = live.get(id);
    const body = (req.body ?? {}) as { slot?: number; alias?: string };
    try {
      if (!game) throw new LobbyError('game is not running on this server');
      if (!body.slot || !body.alias) throw new LobbyError('slot and alias are required');
      await reply.send(await remapSeat(game, body.slot as SlotId, body.alias));
    } catch (e) {
      await reply.code(400).send({ error: messageOf(e) });
    }
  });

  app.post('/api/games/:id/:command', async (req, reply) => {
    if (!requireHost(req, reply)) return;
    const { id, command } = req.params as { id: string; command: string };
    const game = live.get(id);
    if (!game?.orchestrator) {
      // a game that could not be recovered (corrupt, another engine version) can still be ended
      const row = getGame(o.store, id);
      if (command === 'abort' && row && row.status !== 'lobby' && row.status !== 'over' && row.status !== 'aborted') {
        await reply.send({ outcome: abortStoredGame(o.store, id) });
        return;
      }
      await reply.code(404).send({ error: 'game is not running on this server' });
      return;
    }
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const cmd = HostCommandSchema.parse({ cmd: command.replace('-', '_'), ...body });
      await reply.send(applyHostCommand(game, cmd));
    } catch (e) {
      await reply.code(400).send({ error: messageOf(e) });
    }
  });

  app.get('/api/stats/models', (req, reply) => {
    if (!requireHost(req, reply)) return;
    void reply.send({ models: modelStats(o.store) });
  });
  app.get('/api/stats/roles', (req, reply) => {
    if (!requireHost(req, reply)) return;
    void reply.send({ roles: roleStats(o.store) });
  });

  // ---- join links ----------------------------------------------------------------

  const redeem = (req: FastifyRequest, reply: FastifyReply, kind: 'seat' | 'spectator') => {
    const token = (req.params as { token: string }).token;
    const wantsHtml = (req.headers.accept ?? '').includes('text/html');
    const res = redeemJoinToken(o.store, token);
    if (!res || res.session.principal !== kind) {
      const message = 'this link is not valid (it may already have been used)';
      if (wantsHtml && o.webDir) void reply.code(404).type('text/html').send(`<!doctype html><meta charset="utf-8"><title>Link expired</title><body style="font-family:system-ui;background:#11131a;color:#e8eaf2;padding:3rem"><h1>This link no longer works</h1><p>${message}. Ask the host for a new one.</p>`);
      else void reply.code(404).send({ error: message });
      return;
    }
    const name = kind === 'seat' ? seatCookieName(res.session.game_id) : spectatorCookieName(res.session.game_id);
    const withCookie = reply.setCookie(name, res.cookie, { httpOnly: true, sameSite: 'strict', path: '/', secure: false });
    // A browser lands in the game itself. The rejoin code travels in the fragment, which the
    // browser keeps to itself: it is never sent to a server or written to a log.
    const fragment = res.rejoinCode ? `#rejoin=${res.rejoinCode}` : '';
    if (wantsHtml && o.webDir) void withCookie.redirect(`/?game=${encodeURIComponent(res.session.game_id)}${fragment}`, 303);
    else void withCookie.send({ ok: true, gameId: res.session.game_id, slot: res.session.slot, principal: kind, ...(res.rejoinCode ? { rejoinCode: res.rejoinCode } : {}) });
  };
  /**
   * A browser opening a link first gets a page with a "Join" button, and only pressing it uses
   * the link. Chat apps fetch links to draw previews: a plain GET must never burn someone's seat.
   * (A client that does not ask for HTML — the CLI, the tests — is let straight in.)
   */
  const joinPage = (req: FastifyRequest, reply: FastifyReply, kind: 'seat' | 'spectator') => {
    const token = (req.params as { token: string }).token;
    const wantsHtml = (req.headers.accept ?? '').includes('text/html');
    if (!wantsHtml || !o.webDir) {
      redeem(req, reply, kind);
      return;
    }
    const page = (title: string, body: string) =>
      `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title>` +
      `<body style="font-family:system-ui,sans-serif;background:#11131a;color:#e8eaf2;padding:2.5rem 1.2rem;max-width:32rem;margin:auto;line-height:1.5">${body}</body></html>`;
    if (!joinTokenUsable(o.store, token, kind)) {
      void reply.code(404).type('text/html').send(page('Link expired', '<h1>This link no longer works</h1><p>It has already been used, perhaps on another device. Ask the host for a new one.</p>'));
      return;
    }
    const what = kind === 'seat' ? 'take your seat at the table' : 'watch the game';
    void reply
      .type('text/html')
      .header('Cache-Control', 'no-store')
      .send(
        page(
          'Join the game',
          `<h1>Werewolf</h1><p>You have been invited to ${what}.</p>` +
            `<form method="post" action="${kind === 'seat' ? '/join/' : '/spectate/'}${encodeURIComponent(token)}"><button type="submit" style="font:inherit;font-weight:600;padding:.7rem 1.4rem;border-radius:10px;border:0;background:#d8a657;color:#1b1b1b;cursor:pointer">${kind === 'seat' ? 'Join the game' : 'Start watching'}</button></form>` +
            (kind === 'seat' ? '<p style="color:#9aa0b4;font-size:.9rem">This link works once: open it on the device you will play on.</p>' : ''),
        ),
      );
  };
  const redeemPost = (req: FastifyRequest, reply: FastifyReply, kind: 'seat' | 'spectator') => {
    if (!originAllowed(req.headers.origin, req.headers.host)) {
      void reply.code(403).send({ error: 'bad origin' });
      return;
    }
    req.headers.accept = 'text/html';
    redeem(req, reply, kind);
  };
  app.get('/join/:token', (req, reply) => joinPage(req, reply, 'seat'));
  app.get('/spectate/:token', (req, reply) => joinPage(req, reply, 'spectator'));
  app.post('/join/:token', (req, reply) => redeemPost(req, reply, 'seat'));
  app.post('/spectate/:token', (req, reply) => redeemPost(req, reply, 'spectator'));

  // ---- WebSocket ------------------------------------------------------------------

  app.get('/ws', { websocket: true }, (connection, req) => {
    const gameId = (req.query as { game?: string }).game ?? '';
    if (!originAllowed(req.headers.origin, req.headers.host)) {
      connection.close(1008, 'bad origin');
      return;
    }
    const rights = rightsOf(req, gameId);
    const known = !!getGame(o.store, gameId);
    if (!known || (!rights.host && rights.slot === null && !rights.spectator)) {
      connection.close(
        1008,
        rights.converted
          ? 'the game started without you, so your seat was given to a model'
          : rights.reissued
            ? getGame(o.store, gameId)?.status === 'lobby'
              ? 'this link was replaced or withdrawn by the host: ask them for your current link'
              : 'your seat was moved to another device: the host made you a new link'
            : 'not a principal of this game',
      );
      return;
    }
    const game: LiveGame = live.get(gameId) ?? { orchestrator: null, sockets: new Set<Socket>() };
    live.set(gameId, game);
    const socket: Socket = {
      send: (msg) => {
        try {
          connection.send(JSON.stringify(msg));
        } catch {
          // a dead socket is cleaned up by its close handler
        }
      },
      close: (code, reason) => {
        try {
          connection.close(code, reason);
        } catch {
          // already closed
        }
      },
      gameId,
      sent: new Map(),
      slot: rights.slot,
      isHost: rights.host,
      isSpectator: rights.spectator,
      rate: { tokens: RATE_BURST, at: Date.now() },
    };
    game.sockets.add(socket);
    if (socket.slot !== null && game.orchestrator) game.orchestrator.humanConnected(socket.slot);
    if (game.orchestrator) {
      for (const p of principalsFor(game, socket)) socket.send(hello(game, socket, p));
      if (socket.isHost) socket.send(hostStatusOf(game)!);
    } else if (getGame(o.store, gameId)!.status !== 'lobby') {
      sendArchived(socket, gameId);
    } else {
      // still a lobby: tell the client what it joined, and who is connected so far
      socket.send({ type: 'lobby_state', lobby: lobbyPayloadFor(game, gameId, socket) });
      broadcastLobby(game, gameId);
    }

    connection.on('message', (raw: Buffer) => {
      if (raw.length > MAX_MESSAGE_BYTES) {
        socket.send({ type: 'error', message: 'message too large' });
        return;
      }
      if (!allow(socket)) {
        socket.send({ type: 'error', message: 'too many messages; slow down' });
        return;
      }
      let msg;
      try {
        msg = ClientMessageSchema.parse(JSON.parse(raw.toString('utf8')));
      } catch {
        socket.send({ type: 'error', message: 'malformed message' });
        return;
      }
      handleClientMessage(game, socket, msg);
    });

    // The server's own heartbeat: a phone that drops off the network never closes its socket, so
    // without this it would stay "connected" (and could not be reissued) until TCP gives up.
    let alive = true;
    connection.on('pong', () => (alive = true));
    const beat = setInterval(() => {
      if (!alive) {
        connection.terminate();
        return;
      }
      alive = false;
      try {
        connection.ping();
      } catch {
        // closing
      }
    }, HEARTBEAT_MS);

    connection.on('close', () => {
      clearInterval(beat);
      game.sockets.delete(socket);
      if (socket.slot !== null && ![...game.sockets].some((s) => s.slot === socket.slot)) {
        if (game.orchestrator) game.orchestrator.humanDisconnected(socket.slot);
        else broadcastLobby(game, gameId);
      }
    });
  });

  // ---- message plumbing -------------------------------------------------------------

  const connectedSlots = (room: LiveGame): SlotId[] => [...new Set([...room.sockets].map((s) => s.slot).filter((s): s is SlotId => s !== null))].sort((a, b) => a - b);

  const lobbyDraftOrNull = (gameId: string): unknown => {
    try {
      return lobbies.get(gameId);
    } catch {
      return null;
    }
  };

  /** The lobby as one socket may see it: the draft names the models and the people, so only the host gets it (§9.1). */
  function lobbyPayloadFor(room: LiveGame, gameId: string, s: Socket): Record<string, unknown> {
    return { gameId, slot: s.slot, connectedSlots: connectedSlots(room), ...(s.isHost ? { draft: lobbyDraftOrNull(gameId), openLinks: openLinkSlots(gameId) } : {}) };
  }

  /** Seats with a link that was sent but not opened yet: re-making the links would kill those. */
  function openLinkSlots(gameId: string): number[] {
    const rows = o.store.db
      .prepare(`SELECT DISTINCT slot FROM sessions WHERE game_id = ? AND principal = 'seat' AND revoked_at IS NULL AND used_at IS NULL AND join_token_hash IS NOT NULL`)
      .all(gameId) as { slot: number }[];
    return rows.map((r) => r.slot).sort((a, b) => a - b);
  }

  function broadcastLobby(room: LiveGame, gameId: string): void {
    for (const s of room.sockets) s.send({ type: 'lobby_state', lobby: lobbyPayloadFor(room, gameId, s) });
  }

  /**
   * A game that has started but is not running here any more — finished, aborted, or one that
   * could not be recovered — is shown read-only from its stored log, so the host can look back
   * at it (or abort it) instead of being handed a lobby editor for a game that is over.
   */
  function sendArchived(socket: Socket, gameId: string): void {
    const row = getGame(o.store, gameId)!;
    const events = listEngineEvents(o.store, gameId);
    const lock = !!row.lock_open || row.status === 'over';
    const principals: Principal[] = [];
    if (socket.isHost) principals.push({ kind: 'host' });
    const seat = socket.slot !== null ? seatOfSlot(gameId, socket.slot) : null;
    if (socket.slot !== null && seat !== null) principals.push({ kind: 'seat', seat, slot: socket.slot, name: nameOfSeat(gameId, seat) });
    if (socket.isSpectator || (socket.slot !== null && lock)) principals.push({ kind: 'spectator' });
    // A game that has not ended but is not live here was not recovered (it is corrupt, from
    // another engine version, or the server skipped recovery): it can be looked at and aborted.
    const ended = row.status === 'over' || row.status === 'aborted';
    const status = ended ? row.status : 'paused';
    const pauseReason = ended ? null : row.pause_reason === 'corrupt' || row.pause_reason === 'version_mismatch' ? row.pause_reason : 'not_loaded';
    for (const p of principals) {
      const projected = viewFor(events, p, lock);
      socket.send({
        type: 'hello',
        scope: p.kind === 'seat' ? 'seat' : p.kind,
        principal: p,
        gameId,
        status,
        lockOpen: lock,
        view: projected.view,
        entries: projected.entries,
        lastVseq: projected.lastVseq,
        pending: null,
        pauseReason,
        ...(lock ? { models: storedModels(gameId) } : {}),
      });
    }
    if (socket.isHost) {
      socket.send({
        type: 'host_status',
        scope: 'host',
        status,
        pauseReason,
        disconnectedSlots: [],
        costUsd: lock ? row.cost_spent_usd : hostSafeCost(costAtLastBoundary(gameId, events), row.cost_cap_usd, false),
        costCapUsd: row.cost_cap_usd,
        lockOpen: lock,
        debriefPending: false,
        notice: ended ? 'this game has ended' : 'this game is not running on this server: it can only be looked at or aborted',
      });
    }
  }

  /**
   * Seat → model for a game that is no longer live: the profiles frozen when it started, with
   * the latest remap of each seat on top.
   */
  function storedModels(gameId: string): { seat: SeatId; slot: SlotId; alias: string; label: string }[] {
    const row = o.store.db.prepare('SELECT config_json FROM games WHERE id = ?').get(gameId) as { config_json: string | null } | undefined;
    if (!row?.config_json) return [];
    const frozen = JSON.parse(row.config_json) as { slots: { slot: number; profile: { alias: string; label: string } | null }[] };
    const bySeat = new Map<number, { slot: SlotId; alias: string; label: string }>();
    for (const s of frozen.slots) {
      const seat = s.profile ? seatOfSlot(gameId, s.slot as SlotId) : null;
      if (s.profile && seat !== null) bySeat.set(seat, { slot: s.slot as SlotId, alias: s.profile.alias, label: s.profile.label });
    }
    const remaps = o.store.db.prepare('SELECT seat, profile_json FROM seat_profiles WHERE game_id = ? ORDER BY from_eseq').all(gameId) as { seat: number; profile_json: string }[];
    for (const r of remaps) {
      const p = JSON.parse(r.profile_json) as { alias: string; label: string };
      const prev = bySeat.get(r.seat);
      if (prev) bySeat.set(r.seat, { slot: prev.slot, alias: p.alias, label: p.label });
    }
    return [...bySeat.entries()].sort((a, b) => a[0] - b[0]).map(([seat, m]) => ({ seat: seat as SeatId, ...m }));
  }

  function hello(game: LiveGame, socket: Socket, principal: Principal): ServerMessage {
    if (!game.orchestrator) throw new Error('the game has not started yet');
    const lock = game.orchestrator.lockOpen;
    const projected = viewFor(game.orchestrator.events, principal, lock);
    const scope = principal.kind === 'seat' ? 'seat' : principal.kind;
    socket.sent.set(scope, projected.lastVseq);
    const pending = principal.kind === 'seat' ? game.orchestrator.pendingFor(principal.seat) : null;
    const notes = principal.kind === 'seat' ? (o.store.db.prepare('SELECT text FROM human_notes WHERE game_id = ? AND seat = ?').get(game.orchestrator.gameId, principal.seat) as { text: string } | undefined) : undefined;
    return {
      type: 'hello',
      scope,
      principal,
      gameId: game.orchestrator.gameId,
      status: game.orchestrator.displayStatus,
      lockOpen: lock,
      view: projected.view,
      entries: projected.entries,
      lastVseq: projected.lastVseq,
      ...(notes ? { notes: notes.text } : {}),
      ...(pending ? { pending: clientRequest(pending) } : { pending: null }),
      pauseReason: game.orchestrator.status === 'paused' ? game.orchestrator.pauseReason : null,
      ...(lock ? { models: game.orchestrator.seatModels() } : {}),
    };
  }

  function clientRequest(p: PendingHuman): ClientRequest {
    return {
      clientRequestId: p.clientRequestId,
      kind: p.request.kind,
      context: p.request.context,
      legal: p.request.legal as Record<string, unknown>,
      optional: p.request.optional,
      deadlineAt: p.deadlineAt,
      remainingMs: p.deadlineAt === null ? p.remainingMs : Math.max(0, p.deadlineAt - Date.now()),
      totalMs: p.totalMs,
      ...(p.request.words !== undefined ? { words: p.request.words } : {}),
      ...(p.request.channel ? { channel: p.request.channel } : {}),
      ...(p.request.round !== undefined ? { round: p.request.round } : {}),
      ...(p.request.maxRounds !== undefined ? { maxRounds: p.request.maxRounds } : {}),
    };
  }

  function handleClientMessage(game: LiveGame, socket: Socket, msg: ReturnType<typeof ClientMessageSchema.parse>): void {
    const principals = principalsFor(game, socket);
    const has = (kind: Principal['kind']) => principals.some((p) => p.kind === kind);
    switch (msg.type) {
      case 'ping':
        socket.send({ type: 'pong' });
        return;
      case 'resync': {
        if (!game.orchestrator) {
          broadcastLobby(game, socket.gameId);
          return;
        }
        for (const p of principals) socket.send(hello(game, socket, p));
        if (socket.isHost) socket.send(hostStatusOf(game)!);
        return;
      }
      case 'submit_decision': {
        const seat = principals.find((p) => p.kind === 'seat');
        if (!seat || seat.kind !== 'seat') {
          socket.send({ type: 'error', message: 'this socket has no seat' });
          return;
        }
        if (!game.orchestrator) {
          socket.send({ type: 'error', message: 'the game has not started yet' });
          return;
        }
        const res: { ok: true } | { ok: false; issues: string[] } = game.orchestrator.submitDecision(seat.seat, msg.clientRequestId, msg.decision);
        socket.send(res.ok ? { type: 'decision_accepted', scope: 'seat', clientRequestId: msg.clientRequestId } : { type: 'decision_error', scope: 'seat', clientRequestId: msg.clientRequestId, issues: res.issues });
        return;
      }
      case 'notes_update': {
        const seat = principals.find((p) => p.kind === 'seat');
        if (!seat || seat.kind !== 'seat') return;
        o.store.atomic(() => {
          o.store.db
            .prepare('INSERT INTO human_notes (game_id, seat, text, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(game_id, seat) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at')
            .run(socket.gameId, seat.seat, msg.text, new Date().toISOString());
        });
        return;
      }
      case 'host_command': {
        if (!has('host')) {
          socket.send({ type: 'error', message: 'not the host' });
          return;
        }
        const reply = (ok: boolean, message: string) => socket.send({ type: 'command_result', scope: 'host', cmd: msg.command.cmd, ok, message });
        try {
          if (!game.orchestrator) {
            // a game that is not running here (not recovered) can only be aborted
            if (msg.command.cmd !== 'abort') throw new LobbyError('this game is not running on this server: it can only be aborted');
            reply(true, abortArchived(game, socket.gameId));
            return;
          }
          const res = applyHostCommand(game, msg.command);
          reply(res['ok'] !== false, describeCommand(msg.command, res));
        } catch (e) {
          reply(false, messageOf(e));
        }
        return;
      }
    }
  }

  /** Abort a game that is not live here, and show everyone in its room the ended game. */
  function abortArchived(room: LiveGame, gameId: string): string {
    const row = getGame(o.store, gameId);
    if (!row || row.status === 'lobby') throw new LobbyError('this game has not started');
    if (row.status === 'over' || row.status === 'aborted') return 'this game has already ended';
    const outcome = abortStoredGame(o.store, gameId);
    for (const s of room.sockets) sendArchived(s, gameId);
    return outcome === 'over' ? 'the game was ended; its result is kept' : 'the game was aborted';
  }

  /** A host command's result, in the words the host should read. */
  function describeCommand(cmd: ReturnType<typeof HostCommandSchema.parse>, res: Record<string, unknown>): string {
    switch (cmd.cmd) {
      case 'pause':
        return 'the game is paused';
      case 'resume':
        return 'the game carries on';
      case 'abort':
        return res['outcome'] === 'over' ? 'the game was ended; its result is kept' : 'the game was aborted';
      case 'raise_cap':
        return `the cap is now $${cmd.capUsd.toFixed(2)}${res['resumed'] ? ', and the game carries on' : ''}`;
      case 'debrief':
        return cmd.open ? 'the debrief is open' : 'no debrief this time';
      case 'fallback_now':
        // §9.3: while the game is hidden, a night request is only noted, and no count is given
        if (res['refused']) return 'at night, while the game is hidden, only offline players can be settled (and only once the night is over)';
        if (res['deferred']) return 'noted: offline players are settled once the night is over';
        // while the game is hidden the host is not told how many (§9.3)
        if (res['applied'] === undefined) return 'done';
        return Number(res['applied']) ? `settled ${String(res['applied'])} open question${res['applied'] === 1 ? '' : 's'}` : 'there was nothing to settle';
      case 'remap_seat':
        return 'done';
    }
  }

  function applyHostCommand(game: LiveGame, cmd: ReturnType<typeof HostCommandSchema.parse>): Record<string, unknown> {
    const g = game.orchestrator;
    if (!g) throw new LobbyError('the game has not started yet');
    switch (cmd.cmd) {
      case 'pause':
        g.pause('host');
        return { ok: true };
      case 'resume':
        g.resume();
        return { ok: true };
      case 'abort':
        return { ok: true, outcome: g.abortGame() };
      case 'raise_cap': {
        g.raiseCap(cmd.capUsd);
        // raising the cap resumes only a game the cap had paused; a host pause stays a pause
        const resumed = g.status === 'paused' && g.pauseReason === 'cost_cap';
        if (resumed) g.resume();
        return { ok: true, capUsd: cmd.capUsd, resumed };
      }
      case 'remap_seat':
        throw new LobbyError('remap_seat is handled asynchronously; use POST /api/games/:id/remap-seat');
      case 'debrief':
        return { ok: g.answerDebrief(cmd.open) };
      case 'fallback_now': {
        const res = g.fallbackNow(cmd.target);
        // while the game is still hidden, the host learns nothing beyond "noted" (§9.3)
        if (res.refused) return { ok: false, refused: true };
        return res.deferred ? { ok: true, deferred: true } : { ok: true, ...(res.applied === null ? {} : { applied: res.applied }) };
      }
    }
  }

  /** Catalogue entries for every model a stored game uses (cache first, never the network in mock). */
  async function entriesForSnapshot(snapshot: GameSnapshot): Promise<Map<string, CatalogEntry>> {
    const profiles = snapshot.slots.map((s) => s.profile).filter((p): p is NonNullable<typeof p> => p !== null);
    const { entries } = await resolveCatalog(o.env, o.store, profiles, { offline: o.mock ?? false, assume: o.mock ?? false });
    return entries;
  }

  /**
   * Remap a seat's model (§9.5). Only once no human can act, only to an enabled profile, and
   * only to one whose window and output budget fit what the game froze.
   */
  async function remapSeat(game: LiveGame, slot: SlotId, alias: string): Promise<{ ok: boolean }> {
    const g = game.orchestrator;
    if (!g) throw new LobbyError('the game has not started yet');
    if (!g.lockOpen) throw new LobbyError('a seat cannot be remapped while the game is still hidden from the host');
    const profile = o.env.cfg.profilesByAlias.get(alias);
    if (!profile?.enabled) throw new LobbyError(`unknown or disabled model "${alias}"`);
    if (!g.snapshot.slots.some((s) => s.slot === slot)) throw new LobbyError(`unknown slot ${slot}`);
    const { entries } = await resolveCatalog(o.env, o.store, [profile], { offline: o.mock, assume: o.mock });
    const entry = entries.get(profile.openrouterId);
    if (!entry) throw new LobbyError(`no catalogue data for ${profile.openrouterId}`);
    const problem = remapProblem(profile, entry, g.snapshot);
    if (problem) throw new LobbyError(problem);
    const ok = g.remapSeat(slot, profile, entry);
    // the table shows each seat's model: every screen gets a fresh snapshot with the new one
    if (ok) for (const s of game.sockets) for (const p of principalsFor(game, s)) s.send(hello(game, s, p));
    return { ok };
  }

  function wire(game: LiveGame): void {
    const orchestrator = game.orchestrator;
    if (!orchestrator) return;
    orchestrator.subscribe((e) => {
      switch (e.type) {
        case 'events': {
          for (const s of game.sockets) pushEntries(game, s);
          // the host's cost is only refreshed at the Dawn and Dusk boundaries (§9.1)
          const boundary = e.events.some((x) => x.type === 'PHASE_START' && ['dawn', 'dusk'].includes((x.payload as { phase: string }).phase));
          if (boundary) {
            orchestrator.atBoundary();
            pushHostStatus(game);
          }
          break;
        }
        case 'request_closed':
          for (const s of game.sockets) {
            const seat = principalsFor(game, s).find((p) => p.kind === 'seat');
            if (seat?.kind === 'seat' && seat.seat === e.seat) s.send({ type: 'decision_closed', scope: 'seat', clientRequestId: e.clientRequestId });
          }
          break;
        case 'request': {
          for (const s of game.sockets) {
            const seat = principalsFor(game, s).find((p) => p.kind === 'seat');
            if (seat?.kind === 'seat' && seat.seat === e.seat) {
              pushEntries(game, s);
              s.send({ type: 'decision_request', scope: 'seat', request: clientRequest(e.pending) });
            }
          }
          break;
        }
        case 'paused':
          broadcast(game, { type: 'paused', reason: e.reason });
          // the pause froze every human clock, so the deadline each browser holds is now wrong
          resendPending(game);
          pushHostStatus(game);
          break;
        case 'resumed':
          broadcast(game, { type: 'resumed', status: orchestrator.displayStatus });
          resendPending(game); // resume re-armed the clocks with fresh deadlines
          pushHostStatus(game);
          break;
        case 'aborted':
          broadcast(game, { type: 'aborted', reason: 'the host ended this game' });
          pushHostStatus(game);
          break;
        case 'lock_opened':
          broadcast(game, { type: 'lock_opened' });
          for (const s of game.sockets) for (const p of principalsFor(game, s)) s.send(hello(game, s, p));
          break;
        case 'over': {
          const r = orchestrator.engineState.result;
          if (r) broadcast(game, { type: 'game_over', winner: r.winner, reason: r.reason });
          // a fresh snapshot for everyone: the game is open now, with every card and model (§15b)
          for (const s of game.sockets) for (const p of principalsFor(game, s)) s.send(hello(game, s, p));
          pushHostStatus(game);
          break;
        }
        case 'status':
          pushHostStatus(game);
          break;
        default:
          break;
      }
    });
  }

  /** Re-deliver each open request, so its deadline matches the clock the server is really running. */
  function resendPending(game: LiveGame): void {
    const orchestrator = game.orchestrator;
    if (!orchestrator) return;
    for (const s of game.sockets) {
      const seat = principalsFor(game, s).find((p) => p.kind === 'seat');
      if (seat?.kind !== 'seat') continue;
      const pending = orchestrator.pendingFor(seat.seat);
      if (pending) s.send({ type: 'decision_request', scope: 'seat', request: clientRequest(pending) });
    }
  }

  function pushEntries(game: LiveGame, s: Socket): void {
    if (!game.orchestrator) return;
    const lock = game.orchestrator.lockOpen;
    for (const p of principalsFor(game, s)) {
      const scope = p.kind === 'seat' ? 'seat' : p.kind;
      // entries only extend a snapshot this socket already has: before its hello, it gets none
      // (the hello will carry them), so a browser never builds a view without knowing its seat
      if (!s.sent.has(scope)) continue;
      const from = s.sent.get(scope)!;
      const entries = entriesSince(game.orchestrator.events, p, lock, from);
      if (entries.length === 0) continue;
      s.sent.set(scope, entries[entries.length - 1]!.vseq);
      s.send({ type: 'entries', scope, fromVseq: from, entries });
    }
  }

  function hostStatusOf(game: LiveGame): ServerMessage | null {
    const g = game.orchestrator;
    if (!g) return null;
    return {
      type: 'host_status',
      scope: 'host',
      status: g.displayStatus,
      pauseReason: g.status === 'paused' ? g.pauseReason : null,
      disconnectedSlots: g.disconnectedSlots,
      // while hidden: what had been spent at the last Dawn/Dusk, rounded (§9.1)
      costUsd: g.lockOpen ? g.spentUsd : hostSafeCost(costAtLastBoundary(g.gameId, g.events), g.capUsd, false),
      costCapUsd: g.capUsd,
      lockOpen: g.lockOpen,
      debriefPending: g.hostDebriefPending,
      ...(g.notice ? { notice: g.notice } : {}),
      ...(g.status === 'paused' && g.pauseReason === 'provider_failure' && g.pauseDetail ? { pauseDetail: g.pauseDetail } : {}),
      humans: g.humanSlots(),
    };
  }

  /**
   * What had been spent by the last Dawn or Dusk: the cost of every call made for a request that
   * was opened before it. Computed from the store, so it is right after a restart too, and it
   * never reflects a night still in progress (§9.1).
   */
  function costAtLastBoundary(gameId: string, events: readonly { eseq: number; type: string; payload: unknown }[]): number {
    let boundary = 0;
    for (const e of events) if (e.type === 'PHASE_START' && ['dawn', 'dusk'].includes((e.payload as { phase: string }).phase)) boundary = e.eseq;
    if (boundary === 0) return 0;
    const before = events.filter((e) => e.eseq < boundary && e.type === 'REQUEST_OPENED').map((e) => (e.payload as { requestId: number }).requestId);
    if (before.length === 0) return 0;
    const last = Math.max(...before);
    const row = o.store.db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS usd FROM llm_calls WHERE game_id = ? AND internal_id <= ?').get(gameId, last) as { usd: number };
    return row.usd;
  }

  function pushHostStatus(game: LiveGame): void {
    const msg = hostStatusOf(game);
    if (msg) for (const s of game.sockets) if (s.isHost) s.send(msg);
  }

  function broadcast(game: LiveGame, msg: ServerMessage): void {
    for (const s of game.sockets) s.send(msg);
  }

  // Shutting the server down stops every running game: a game must never keep writing to a
  // store that is being closed.
  app.addHook('onClose', async () => {
    for (const g of live.values()) {
      g.orchestrator?.stop();
      for (const s of g.sockets) void s;
      g.sockets.clear();
    }
    live.clear();
    await Promise.resolve();
  });

  /**
   * Recover games that were running when the server stopped (§9.4). They come back paused
   * with reason `recovered`; the host resumes them, so a crash loop cannot spend money.
   */
  async function recoverAll(): Promise<{ gameId: string; problem: string | null }[]> {
    const out: { gameId: string; problem: string | null }[] = [];
    for (const gameId of recoverableGames(o.store)) {
      try {
        const rec = recoverGame(o.store, gameId);
        out.push({ gameId, problem: rec.problem });
        if (rec.problem) continue; // the host can only abort or export these
        const game = new GameOrchestrator({
          store: o.store,
          gameId,
          snapshot: rec.snapshot,
          pack: o.env.pack,
          app: o.env.cfg.app,
          provider: provider(),
          entries: await entriesForSnapshot(rec.snapshot),
          profilesByAlias: o.env.cfg.profilesByAlias,
          logPrompts: o.logPrompts ?? false,
          resume: { state: rec.state, events: rec.events, applyOrder: rec.applyOrder, spentUsd: rec.spentUsd },
        });
        game.pause('recovered');
        const room: LiveGame = live.get(gameId) ?? { orchestrator: null, sockets: new Set<Socket>() };
        room.orchestrator = game;
        live.set(gameId, room);
        wire(room);
        // Nobody is connected yet after a restart: every player counts as offline until they come
        // back, so "Skip offline players", the away fallback and the all-offline pause all work.
        for (const h of game.humanSlots()) if (![...room.sockets].some((x) => x.slot === h.slot)) game.humanDisconnected(h.slot);
        // the loop starts and waits in its paused state until the host resumes (§9.4 step 6)
        void game.run().catch((err: unknown) => {
          app.log.error(err);
          broadcast(room, { type: 'error', message: (err as Error).message });
        });
      } catch (e) {
        out.push({ gameId, problem: messageOf(e) });
      }
    }
    return out;
  }

  // expose the internals the CLI and tests need
  (app as FastifyInstance & { ww?: unknown }).ww = {
    lobbies,
    live,
    recoverAll,
    session: (gameId: string, cookieValue: string): SessionRow | undefined => sessionByCookie(o.store, gameId, cookieValue),
    decisions: (gameId: string) => listDecisions(o.store, gameId),
    gameRow: (gameId: string) => getGame(o.store, gameId),
    newId: () => randomUUID(),
  };
  return app;
}
