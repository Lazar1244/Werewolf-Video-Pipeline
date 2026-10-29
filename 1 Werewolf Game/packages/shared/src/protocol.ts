import { z } from 'zod';
import { DECISION_KINDS } from './decisions';
import { SeatIdSchema, SlotIdSchema } from './events';
import { ROLE_IDS } from './roles';

/**
 * REST bodies and WebSocket messages (ARCHITECTURE.md §11). The server validates every
 * incoming message against these schemas; `client-sdk` and the web UI import the types.
 */

export const PrincipalSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('host') }),
  z.strictObject({ kind: z.literal('seat'), seat: SeatIdSchema, slot: SlotIdSchema, name: z.string() }),
  z.strictObject({ kind: z.literal('spectator') }),
]);
export type Principal = z.infer<typeof PrincipalSchema>;

export const ScopeSchema = z.enum(['host', 'seat', 'spectator']);
export type Scope = z.infer<typeof ScopeSchema>;

/** A decision the server is waiting for from a human seat. */
export const ClientRequestSchema = z.strictObject({
  clientRequestId: z.string().min(1),
  kind: z.enum(DECISION_KINDS),
  context: z.string(),
  legal: z.record(z.string(), z.unknown()),
  words: z.int().optional(),
  optional: z.boolean(),
  channel: z.string().optional(),
  round: z.int().optional(),
  maxRounds: z.int().optional(),
  /** Epoch milliseconds; null while the game is paused (the clock is frozen). */
  deadlineAt: z.number().nullable(),
  /**
   * Time left when the server sent this, so a device whose clock is off still shows the right
   * countdown (it measures from when the message arrived, not from `deadlineAt`).
   */
  remainingMs: z.number().optional(),
  /** The whole time this request was given, so the countdown bar has the same scale after a reload. */
  totalMs: z.number().optional(),
});
export type ClientRequest = z.infer<typeof ClientRequestSchema>;

/** Which model played a seat. Only sent once the lock is open (ruleset §9 and §15b). */
export const SeatModelInfoSchema = z.strictObject({ seat: SeatIdSchema, slot: SlotIdSchema, alias: z.string(), label: z.string() });
export type SeatModelInfo = z.infer<typeof SeatModelInfoSchema>;
/** The longest private notes a player can keep (UTF-16 units: at most ~12 KB of UTF-8). */
export const NOTES_MAX_CHARS = 4_000;

export const LOBBY_STATUSES = ['lobby', 'running', 'paused', 'over_offer', 'debrief', 'over', 'aborted'] as const;

export const ServerMessageSchema = z.discriminatedUnion('type', [
  /** Full snapshot: on connect, on resync, and whenever the spectator lock opens. */
  z.strictObject({
    type: z.literal('hello'),
    scope: ScopeSchema,
    principal: PrincipalSchema,
    gameId: z.string(),
    status: z.enum(LOBBY_STATUSES),
    lockOpen: z.boolean(),
    view: z.unknown(),
    entries: z.array(z.unknown()),
    lastVseq: z.int(),
    notes: z.string().optional(),
    pending: ClientRequestSchema.nullable().optional(),
    /** Why the game is paused, so a device that connects during a pause knows it (and can resume). */
    pauseReason: z.string().nullable().optional(),
    /** Seat → model, only while the lock is open. */
    models: z.array(SeatModelInfoSchema).optional(),
  }),
  z.strictObject({ type: z.literal('entries'), scope: ScopeSchema, fromVseq: z.int(), entries: z.array(z.unknown()) }),
  z.strictObject({ type: z.literal('decision_request'), scope: z.literal('seat'), request: ClientRequestSchema }),
  z.strictObject({ type: z.literal('decision_accepted'), scope: z.literal('seat'), clientRequestId: z.string() }),
  z.strictObject({ type: z.literal('decision_error'), scope: z.literal('seat'), clientRequestId: z.string(), issues: z.array(z.string()) }),
  /** The request was settled without this player (timeout, host fallback, away): stop asking. */
  z.strictObject({ type: z.literal('decision_closed'), scope: z.literal('seat'), clientRequestId: z.string() }),
  z.strictObject({ type: z.literal('paused'), reason: z.string() }),
  /** The game carries on; `status` says where (running, or back in the debrief). */
  z.strictObject({ type: z.literal('resumed'), status: z.enum(LOBBY_STATUSES).optional() }),
  z.strictObject({ type: z.literal('lock_opened') }),
  z.strictObject({ type: z.literal('game_over'), winner: z.string(), reason: z.string() }),
  /** The host ended the game before it finished: everyone is told, not only the host (§9.3). */
  z.strictObject({ type: z.literal('aborted'), reason: z.string() }),
  /** Host-safe status (§9.1): cost only at Dawn/Dusk boundaries and rounded, no seat data. */
  z.strictObject({
    type: z.literal('host_status'),
    scope: z.literal('host'),
    status: z.enum(LOBBY_STATUSES),
    pauseReason: z.string().nullable(),
    disconnectedSlots: z.array(SlotIdSchema),
    costUsd: z.number().nullable(),
    costCapUsd: z.number(),
    lockOpen: z.boolean(),
    /** The game is over and waiting for the host to open or skip the debrief (ruleset §15b). */
    debriefPending: z.boolean(),
    notice: z.string().optional(),
    /** What a `provider_failure` pause is about: a model that keeps failing, or the API key. */
    pauseDetail: z.enum(['model_failed', 'api_key']).optional(),
    /**
     * The people playing, by lobby slot: names the host typed in, and whether each is connected.
     * Slots never map to seats, so this says nothing about the game (§9.1).
     */
    humans: z.array(z.strictObject({ slot: SlotIdSchema, name: z.string(), connected: z.boolean() })).optional(),
  }),
  z.strictObject({ type: z.literal('lobby_state'), lobby: z.unknown() }),
  /** The outcome of a host command, in words, for the host who sent it. */
  z.strictObject({ type: z.literal('command_result'), scope: z.literal('host'), cmd: z.string(), ok: z.boolean(), message: z.string() }),
  z.strictObject({ type: z.literal('error'), message: z.string() }),
  z.strictObject({ type: z.literal('pong') }),
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;

export const HostCommandSchema = z.discriminatedUnion('cmd', [
  z.strictObject({ cmd: z.literal('pause') }),
  z.strictObject({ cmd: z.literal('resume') }),
  z.strictObject({ cmd: z.literal('abort') }),
  z.strictObject({ cmd: z.literal('raise_cap'), capUsd: z.number().positive() }),
  z.strictObject({ cmd: z.literal('remap_seat'), slot: SlotIdSchema, alias: z.string() }),
  z.strictObject({ cmd: z.literal('debrief'), open: z.boolean() }),
  /** Apply the ruleset fallback now: all disconnected humans, or the current public speaker. */
  z.strictObject({ cmd: z.literal('fallback_now'), target: z.enum(['disconnected', 'current_speaker', 'all_ballots']) }),
]);
export type HostCommand = z.infer<typeof HostCommandSchema>;

export const ClientMessageSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('submit_decision'), scope: z.literal('seat'), clientRequestId: z.string().min(1), decision: z.unknown() }),
  /** Notes are capped well under the socket's 16 KB message limit, whatever the script (§11.2). */
  z.strictObject({ type: z.literal('notes_update'), scope: z.literal('seat'), text: z.string().max(NOTES_MAX_CHARS) }),
  z.strictObject({ type: z.literal('host_command'), scope: z.literal('host'), command: HostCommandSchema }),
  z.strictObject({ type: z.literal('resync'), scope: ScopeSchema.optional(), fromVseq: z.int().optional() }),
  z.strictObject({ type: z.literal('ping') }),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

/** Lobby draft (ARCHITECTURE.md §9.2). Slots are filled before the game starts. */
export const LobbySlotSchema = z.strictObject({
  slot: SlotIdSchema,
  controller: z.enum(['ai', 'human', 'bot']),
  alias: z.string().nullable(),
  humanName: z.string().min(1).max(40).nullable(),
});
export type LobbySlot = z.infer<typeof LobbySlotSchema>;

/**
 * A custom game (owner request, 2026-10-26): the host seats the players and deals the cards.
 * `roles[i]` is the card of slot i + 1, which also sits at seat i + 1; with a Thief, `extras` are
 * the two cards left in the middle. Together they must be exactly the mode's cards.
 */
export const ManualDealSchema = z.strictObject({
  roles: z.array(z.enum(ROLE_IDS)).min(5).max(10),
  extras: z.array(z.enum(ROLE_IDS)).max(2).optional(),
});
export type ManualDeal = z.infer<typeof ManualDealSchema>;

export const LobbyDraftSchema = z.strictObject({
  compositionId: z.string().min(1),
  slots: z.array(LobbySlotSchema).min(5).max(10),
  costCapUsd: z.number().positive(),
  seed: z.string().min(1).optional(),
  rulesOverride: z.record(z.string(), z.unknown()).optional(),
  debrief: z.boolean().optional(),
  /** Set: the host's own seats and cards. Absent (or null in a patch): seats and cards dealt at random. */
  manualDeal: ManualDealSchema.nullable().optional(),
});
export type LobbyDraft = z.infer<typeof LobbyDraftSchema>;

export const LobbyPatchSchema = LobbyDraftSchema.partial();
export type LobbyPatch = z.infer<typeof LobbyPatchSchema>;

export const StartRequestSchema = z.strictObject({
  /** Start without every human connected; their slots become AI or bot seats. */
  force: z.boolean().optional(),
  forcedAlias: z.string().optional(),
});
export type StartRequest = z.infer<typeof StartRequestSchema>;

/** One-time join links handed out by the host (§9.1). */
export const LinksSchema = z.strictObject({
  seats: z.array(z.strictObject({ slot: SlotIdSchema, humanName: z.string(), url: z.string() })),
  spectator: z.string(),
  /** Slots whose player has already joined: they get no new link (their seat is theirs). */
  joined: z.array(SlotIdSchema).optional(),
});
export type Links = z.infer<typeof LinksSchema>;
