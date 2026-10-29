import { randomUUID } from 'node:crypto';
import { ENGINE_VERSION } from '@ww/engine';
import { LobbyDraftSchema, manualDealFrom, manualDealProblem, RulesOverrideSchema, type GameSnapshot, type Links, type LobbyDraft, type LobbyPatch, type SlotId, type StartRequest } from '@ww/shared';
import { createLobby, getGame, putPromptPack, putSlots, startGame, updateLobby, type Store } from '@ww/store';
import { activeSeatSessions, createSession, newToken, rejoinCodeMatches, revokeSession, sessionsOfGame } from './auth';
import { buildGame, type Env } from './setup';
import type { CatalogEntry } from '@ww/llm';

/**
 * LobbyService (ARCHITECTURE.md §9.2): the editable draft before a game starts, the one-time
 * join links, the cost pre-flight and the start conditions.
 */
export class LobbyError extends Error {}

export interface StartedGame {
  gameId: string;
  snapshot: GameSnapshot;
  entries: Map<string, CatalogEntry>;
  warnings: string[];
}

export class LobbyService {
  constructor(
    private readonly env: Env,
    private readonly store: Store,
  ) {}

  /**
   * A draft with every slot filled from a roster (or the first enabled model). `manual`: a custom
   * game, where the host seats the players and deals the cards (starting from the mode's own order).
   */
  defaultDraft(compositionId: string, aliases?: string[], manual = false): LobbyDraft {
    const comp = this.env.cfg.compositions.get(compositionId);
    if (!comp) throw new LobbyError(`unknown composition "${compositionId}"`);
    const pool = aliases?.length ? aliases : [...this.env.cfg.profilesByAlias.values()].filter((p) => p.enabled).map((p) => p.alias);
    if (pool.length === 0) throw new LobbyError('no enabled models in models.json');
    return {
      compositionId,
      slots: Array.from({ length: comp.seats }, (_, i) => ({ slot: (i + 1) as SlotId, controller: 'ai' as const, alias: pool[i % pool.length]!, humanName: null })),
      costCapUsd: this.env.cfg.app.defaultCostCapUsd,
      ...(manual ? { manualDeal: manualDealFrom(comp.cards, comp.seats) } : {}),
    };
  }

  create(draft: LobbyDraft): string {
    const parsed = LobbyDraftSchema.parse(draft);
    this.validate(parsed);
    const id = randomUUID();
    createLobby(this.store, { id, lobby: parsed, costCapUsd: parsed.costCapUsd });
    return id;
  }

  get(id: string): LobbyDraft {
    const row = getGame(this.store, id);
    if (!row) throw new LobbyError(`game ${id} not found`);
    if (!row.lobby_json) throw new LobbyError(`game ${id} has no lobby draft`);
    return LobbyDraftSchema.parse(JSON.parse(row.lobby_json));
  }

  patch(id: string, patch: LobbyPatch): LobbyDraft {
    const row = getGame(this.store, id);
    if (!row) throw new LobbyError(`game ${id} not found`);
    if (row.status !== 'lobby') throw new LobbyError('the game has already started');
    const prev = this.get(id);
    const next = LobbyDraftSchema.parse({ ...prev, ...patch });
    // another mode on a custom game: the host's deal starts again from the new mode's cards
    const comp = patch.compositionId && patch.compositionId !== prev.compositionId ? this.env.cfg.compositions.get(patch.compositionId) : undefined;
    if (comp && prev.manualDeal && patch.manualDeal === undefined) next.manualDeal = manualDealFrom(comp.cards, comp.seats);
    this.validate(next);
    updateLobby(this.store, id, next, next.costCapUsd);
    return next;
  }

  /** Lobby rules that do not depend on the models being reachable. */
  private validate(draft: LobbyDraft): void {
    const comp = this.env.cfg.compositions.get(draft.compositionId);
    if (!comp) throw new LobbyError(`unknown composition "${draft.compositionId}"`);
    if (draft.slots.length !== comp.seats) throw new LobbyError(`composition "${comp.id}" needs exactly ${comp.seats} slots`);
    const slots = new Set(draft.slots.map((s) => s.slot));
    if (slots.size !== draft.slots.length) throw new LobbyError('duplicate slot numbers');
    for (const s of draft.slots) {
      if (s.controller === 'ai') {
        const p = s.alias ? this.env.cfg.profilesByAlias.get(s.alias) : undefined;
        if (!p) throw new LobbyError(`slot ${s.slot}: unknown model alias "${s.alias ?? ''}"`);
        if (!p.enabled) throw new LobbyError(`slot ${s.slot}: model "${s.alias}" is disabled`);
      }
      if (s.controller === 'human' && !s.humanName) throw new LobbyError(`slot ${s.slot}: a human slot needs a name`);
    }
    if (draft.rulesOverride) {
      const parsed = RulesOverrideSchema.safeParse(draft.rulesOverride);
      if (!parsed.success) throw new LobbyError(`rule overrides are invalid: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    }
    if (draft.manualDeal) {
      const problem = manualDealProblem(comp.cards, comp.seats, draft.manualDeal);
      if (problem) throw new LobbyError(`the seats' cards do not fit "${comp.id}": ${problem}`);
    }
    const humans = draft.slots.filter((s) => s.controller === 'human');
    if (humans.length > 0 && !this.env.cfg.app.defaultFallbackAlias) {
      // §9.5: with humans in the game a failed model must be replaceable without a pause
      throw new LobbyError('with human seats, app.json needs a defaultFallbackAlias so a failed model can be replaced silently');
    }
  }

  /**
   * One-time links: one per human slot plus a spectator link. Each player's rejoin code is made
   * when they open their link, on their own device, so the host never sees it (§9.1).
   *
   * Reissuing a seat link after the game has started is how a human gets back in after losing
   * their session. While the lock is closed it always needs that seat's rejoin code (§9.1),
   * so the host alone cannot hand a live seat to someone else.
   */
  reissueSeatLink(id: string, slot: SlotId, baseUrl: string, opts: { rejoinCode?: string; lockOpen: boolean; connected?: boolean }): { url: string } {
    const row = getGame(this.store, id);
    if (!row) throw new LobbyError(`game ${id} not found`);
    if (row.status === 'lobby') throw new LobbyError('the game has not started: issue the lobby links instead');
    const human = this.store.db.prepare(`SELECT controller FROM slots WHERE game_id = ? AND slot = ?`).get(id, slot) as { controller: string } | undefined;
    if (human && human.controller !== 'human') throw new LobbyError(`slot ${slot} is played by a model: there is no link to make for it`);
    // §9.1: a live seat is only reissued while it is disconnected, and only with its own code
    if (opts.connected) throw new LobbyError('that seat is connected right now; it can only be reissued while it is disconnected');
    if (!opts.lockOpen) {
      if (!opts.rejoinCode) throw new LobbyError('this seat can only be reissued with its rejoin code while the game is still hidden');
      if (!rejoinCodeMatches(this.store, id, slot, opts.rejoinCode)) throw new LobbyError('that rejoin code does not match this seat');
    }
    for (const s of sessionsOfGame(this.store, id)) if (s.slot === slot && s.principal === 'seat') revokeSession(this.store, s.id);
    const token = newToken();
    createSession(this.store, { id: randomUUID(), gameId: id, principal: 'seat', slot, joinToken: token });
    this.store.atomic(() => {
      this.store.db
        .prepare('INSERT INTO meta_events (game_id, mseq, wall_time, type, vis, payload_json) VALUES (?, (SELECT COALESCE(MAX(mseq),0)+1 FROM meta_events WHERE game_id = ?), ?, ?, ?, ?)')
        .run(id, id, new Date().toISOString(), 'LINK_REISSUED', 'host_safe', JSON.stringify({ slot }));
    });
    return { url: `${baseUrl}/join/${token}` };
  }

  issueLinks(id: string, baseUrl: string): Links {
    // Once the game has started a seat changes hands only through a reissue, which needs the
    // player's rejoin code while the game is hidden: fresh links would bypass that (§9.1).
    if (getGame(this.store, id)?.status !== 'lobby') throw new LobbyError('the game has started: a player who lost their link gets a new one from "More host tools"');
    const draft = this.get(id);
    const seats: Links['seats'] = [];
    const joined: SlotId[] = [];
    for (const s of draft.slots.filter((x) => x.controller === 'human')) {
      const active = activeSeatSessions(this.store, id, s.slot);
      // A player who already joined keeps their seat: a new link for it would be a second device
      // on the same seat. To move a joined player, the host replaces that one link on purpose.
      if (active.some((x) => x.used_at)) {
        joined.push(s.slot);
        continue;
      }
      // a fresh set of links invalidates any earlier unused one for that slot
      for (const old of active) revokeSession(this.store, old.id);
      const token = newToken();
      createSession(this.store, { id: randomUUID(), gameId: id, principal: 'seat', slot: s.slot, joinToken: token });
      seats.push({ slot: s.slot, humanName: s.humanName ?? `seat ${s.slot}`, url: `${baseUrl}/join/${token}` });
    }
    const specToken = newToken();
    createSession(this.store, { id: randomUUID(), gameId: id, principal: 'spectator', slot: null, joinToken: specToken });
    return { seats, spectator: `${baseUrl}/spectate/${specToken}`, joined };
  }

  /**
   * In the lobby, replace one player's link: every earlier session of that seat is revoked (the
   * device that joined with it is shut out) and a single new link is made. Nothing is secret yet
   * in a lobby, so no rejoin code is needed; after the start this is `reissueSeatLink`.
   */
  replaceLobbyLink(id: string, slot: SlotId, baseUrl: string): { url: string } {
    if (getGame(this.store, id)?.status !== 'lobby') throw new LobbyError('the game has started: use "More host tools" to make a player a new link');
    const draft = this.get(id);
    if (!draft.slots.some((s) => s.slot === slot && s.controller === 'human')) throw new LobbyError(`slot ${slot} is not played by a person`);
    for (const s of sessionsOfGame(this.store, id)) if (s.principal === 'seat' && s.slot === slot && !s.revoked_at) revokeSession(this.store, s.id);
    const token = newToken();
    createSession(this.store, { id: randomUUID(), gameId: id, principal: 'seat', slot, joinToken: token });
    return { url: `${baseUrl}/join/${token}` };
  }

  /**
   * A spectator link, at any time and as often as wanted. It can be opened by any number of people
   * and never touches the seat links. A spectator sees only the public game until the lock opens.
   */
  spectatorLink(id: string, baseUrl: string): { url: string } {
    const row = getGame(this.store, id);
    if (!row) throw new LobbyError(`game ${id} not found`);
    const token = newToken();
    createSession(this.store, { id: randomUUID(), gameId: id, principal: 'spectator', slot: null, joinToken: token });
    return { url: `${baseUrl}/spectate/${token}` };
  }

  /** Seat sessions of slots the draft no longer gives to a person: their links must open nothing. */
  revokeNonHuman(id: string): number[] {
    const draft = this.get(id);
    const human = new Set(draft.slots.filter((s) => s.controller === 'human').map((s) => s.slot));
    const gone: number[] = [];
    for (const s of sessionsOfGame(this.store, id)) {
      if (s.principal === 'seat' && s.slot !== null && !human.has(s.slot as SlotId) && !s.revoked_at) {
        revokeSession(this.store, s.id);
        gone.push(s.slot);
      }
    }
    return [...new Set(gone)];
  }

  /** Throw away a lobby that was never started. */
  discard(id: string): void {
    const row = getGame(this.store, id);
    if (!row) throw new LobbyError(`game ${id} not found`);
    if (row.status !== 'lobby') throw new LobbyError('only a lobby that never started can be discarded; abort a game instead');
    this.store.atomic(() => {
      this.store.db.prepare('DELETE FROM games WHERE id = ?').run(id);
    });
  }

  /**
   * Cost pre-flight (§7.5). Only model seats make calls. A model that has played before is priced
   * from what its calls really cost (the median of its past calls); one that has not is priced
   * from its list price with the full output allowance, which overestimates — the result says
   * which basis it used.
   */
  async estimate(id: string): Promise<{ calls: [number, number]; usd: [number, number]; perModel: { alias: string; usdPerCall: number; basis: 'history' | 'prices' }[]; basis: 'history' | 'prices' | 'mixed' }> {
    const draft = this.get(id);
    const aiSeats = draft.slots.filter((s) => s.controller === 'ai');
    const built = await buildGame({ env: this.env, store: this.store, compositionId: draft.compositionId, aliases: aliasesOf(draft), seed: 'estimate', costCapUsd: draft.costCapUsd, ...(draft.rulesOverride ? { rulesOverride: draft.rulesOverride as never } : {}), offline: true, mock: true });
    const calls: [number, number] = [aiSeats.length * 30, aiSeats.length * 55];
    const promptTokens = 6000;
    const outTokens = built.snapshot.pinned.maxOutputTokens;
    const perModel = [...new Set(built.snapshot.slots.map((s) => s.profile).filter(Boolean))].map((p) => {
      const past = this.store.db
        .prepare(
          `SELECT c.cost_usd FROM llm_calls c JOIN games g ON g.id = c.game_id
           WHERE c.profile_alias = ? AND c.status = 'ok' AND c.cost_usd IS NOT NULL AND c.purpose IN ('initial','repair')
             AND (g.lock_open = 1 OR g.status IN ('over','aborted'))
           ORDER BY c.cost_usd`,
        )
        .all(p!.alias) as { cost_usd: number }[];
      if (past.length >= 5) return { alias: p!.alias, usdPerCall: past[Math.floor(past.length / 2)]!.cost_usd, basis: 'history' as const };
      const e = built.entries.get(p!.openrouterId)!;
      return { alias: p!.alias, usdPerCall: promptTokens * e.pricing.prompt + outTokens * e.pricing.completion, basis: 'prices' as const };
    });
    // weight each model by the number of seats it plays
    const perSeat = aiSeats.map((s) => perModel.find((m) => m.alias === s.alias)?.usdPerCall ?? 0);
    const avg = perSeat.reduce((a, x) => a + x, 0) / Math.max(1, perSeat.length);
    const bases = new Set(perModel.map((m) => m.basis));
    const basis = bases.size === 1 ? [...bases][0]! : 'mixed';
    return { calls, usd: [calls[0] * avg, calls[1] * avg], perModel, basis };
  }

  /** Freeze the config and start the game (§8 frozen snapshot, §9.2 start conditions). */
  async start(id: string, opts: StartRequest & { connectedSlots?: SlotId[]; offline?: boolean; mock?: boolean }): Promise<StartedGame> {
    const row = getGame(this.store, id);
    if (!row) throw new LobbyError(`game ${id} not found`);
    if (row.status !== 'lobby') throw new LobbyError('the game has already started');
    const draft = this.get(id);
    const connected = new Set(opts.connectedSlots ?? []);
    const missing = draft.slots.filter((s) => s.controller === 'human' && !connected.has(s.slot));
    if (missing.length && !opts.force) {
      throw new LobbyError(`waiting for ${missing.length} human seat(s) to connect; start with force to fill them with models`);
    }

    // A forced start turns unconnected human slots into AI (or bot) seats (§9.2).
    const forcedAlias = opts.forcedAlias ?? draft.slots.find((s) => s.controller === 'ai')?.alias ?? this.env.cfg.app.defaultFallbackAlias;
    const slots = draft.slots.map((s) => (missing.includes(s) ? { ...s, controller: forcedAlias ? ('ai' as const) : ('bot' as const), alias: forcedAlias ?? null, humanName: null } : s));
    if (missing.length) {
      if (forcedAlias && !this.env.cfg.profilesByAlias.get(forcedAlias)?.enabled) throw new LobbyError(`forced start needs an enabled model alias (got "${forcedAlias}")`);
    }

    const built = await buildGame({
      env: this.env,
      store: this.store,
      compositionId: draft.compositionId,
      aliases: slots.map((s) => s.alias ?? ''),
      perSlotAliases: slots.map((s) => (s.controller === 'ai' ? s.alias : null)),
      humanSlots: slots.filter((s) => s.controller === 'human').map((s) => s.slot),
      humanNames: Object.fromEntries(slots.filter((s) => s.controller === 'human').map((s) => [s.slot, s.humanName ?? `seat ${s.slot}`])),
      seed: draft.seed ?? randomUUID().slice(0, 8),
      costCapUsd: draft.costCapUsd,
      botSlots: slots.filter((s) => s.controller === 'bot').map((s) => s.slot),
      debrief: draft.debrief ?? true,
      ...(draft.rulesOverride ? { rulesOverride: draft.rulesOverride as never } : {}),
      ...(draft.manualDeal ? { manualDeal: draft.manualDeal } : {}),
      offline: opts.offline,
      mock: opts.mock,
    });

    putPromptPack(this.store, this.env.pack.hash, this.env.pack.files);
    startGame(this.store, id, { config: built.snapshot, seed: built.snapshot.game.seed, engineVersion: ENGINE_VERSION, promptPackHash: this.env.pack.hash });
    putSlots(
      this.store,
      id,
      built.snapshot.slots.map((s) => ({ slot: s.slot, seat: null, displayName: null, controller: s.controller, humanName: s.humanName })),
    );
    if (built.snapshot.slots.some((s) => s.controller === 'bot')) {
      this.store.atomic(() => {
        this.store.db.prepare('UPDATE games SET has_bot = 1 WHERE id = ?').run(id);
      });
    }
    if (missing.length) {
      // A seat given to a model must not be reachable through the link meant for the person who
      // never came: that link would open the model's private screen (§9.1).
      for (const s of sessionsOfGame(this.store, id)) if (s.principal === 'seat' && missing.some((m) => m.slot === s.slot)) revokeSession(this.store, s.id);
      this.store.atomic(() => {
        this.store.db
          .prepare('INSERT INTO meta_events (game_id, mseq, wall_time, type, vis, payload_json) VALUES (?, (SELECT COALESCE(MAX(mseq),0)+1 FROM meta_events WHERE game_id = ?), ?, ?, ?, ?)')
          .run(id, id, new Date().toISOString(), 'FORCED_START', 'host_full', JSON.stringify({ slots: missing.map((s) => s.slot) }));
      });
    }
    return { gameId: id, snapshot: built.snapshot, entries: built.entries, warnings: built.warnings };
  }
}

const aliasesOf = (draft: LobbyDraft): string[] => {
  const list = draft.slots.map((s) => s.alias).filter((a): a is string => !!a);
  return list.length ? list : [];
};
