import { z } from 'zod';
import { ROLE_IDS, TEAMS } from './roles';
import { ChannelLabelSchema, type EngineEvent } from './events';

/**
 * Payload schema for every engine event type (ARCHITECTURE.md §4.2, ruleset §16).
 * The engine's `emit` is typed against this map, and a test validates every event of
 * the simulation corpus against it. The UI imports these types.
 */

const seat = z.int().min(1).max(10);
const addressee = z.int().min(0).max(10);
const role = z.enum(ROLE_IDS);
const team = z.enum(TEAMS);
const dayNight = z.int().min(0);

const reveal = z.union([
  z.strictObject({ role, infected: z.boolean().optional() }),
  z.strictObject({ team }),
  z.null(),
]);

const DEATH_CAUSE = z.enum(['attack', 'bbw', 'white_wolf', 'poison', 'knight_curse', 'heartbreak', 'hunter', 'execution']);

const RULES_LOOSE = z.record(z.string(), z.unknown());

export const EngineEventPayloads = {
  // --- setup
  GAME_START: z.strictObject({
    seats: z.array(z.strictObject({ seat, name: z.string() })),
    composition: z.array(role),
    /** Number of cards in the composition that are not in play (Thief extras). */
    extras: z.int().min(0),
    rules: RULES_LOOSE,
  }),
  SEATING: z.strictObject({ seats: z.array(z.strictObject({ seat, slot: z.int(), human: z.boolean() })) }),
  ROLE_ASSIGNED: z.strictObject({ seat, role, team }),
  ROLE_CHANGED: z.strictObject({
    seat,
    role,
    team,
    wolfNature: z.boolean(),
    reason: z.enum(['thief', 'wolf_hound', 'infected', 'wild_child', 'lovers', 'cupid_reverted', 'angel']),
  }),
  THIEF_OFFER: z.strictObject({ extras: z.tuple([role, role]) }),
  PACK_JOINED: z.strictObject({ seat, role, reason: z.enum(['wolf_hound', 'thief', 'infected', 'wild_child']), pack: z.array(seat).min(1) }),
  LOVER_INFO: z.strictObject({ partner: seat, partnerRole: role.optional() }),
  SISTER_INFO: z.strictObject({ sister: seat }),
  CHANNEL_MSG: z.strictObject({ channel: ChannelLabelSchema, seat, round: z.int().min(1), message: z.string() }),
  // --- phases
  PHASE_START: z.strictObject({ phase: z.enum(['night', 'dawn', 'day', 'dusk']), night: dayNight.optional(), day: dayNight.optional() }),
  NIGHT_STEP_START: z.strictObject({ step: z.int(), role: z.string() }),
  NIGHT_ACTION: z.strictObject({
    role: z.string(),
    seat,
    target: seat.nullable().optional(),
    targets: z.array(seat).optional(),
    choice: z.string().optional(),
    heal: z.boolean().optional(),
    poison: seat.nullable().optional(),
  }),
  // --- night information
  SEER_RESULT: z.strictObject({ target: seat, result: z.string() }),
  FOX_RESULT: z.strictObject({ target: seat, wolfAmong: z.boolean(), lostPower: z.boolean() }),
  PACK_INFO: z.strictObject({ pack: z.array(z.strictObject({ seat, role })) }),
  PACK_LEADER: z.strictObject({ leader: seat }),
  COUNCIL_MSG: z.strictObject({ seat, round: z.int().min(1), message: z.string(), proposed_target: seat.nullable(), ready: z.boolean() }),
  COUNCIL_BALLOTS: z.strictObject({ ballots: z.array(z.strictObject({ seat, target: seat.nullable() })) }),
  COUNCIL_RESULT: z.strictObject({ victim: seat.nullable() }),
  COUNCIL_SKIPPED: z.strictObject({ reason: z.string() }),
  LITTLE_GIRL_CAUGHT: z.strictObject({ seat }),
  LITTLE_GIRL_TRANSCRIPT: z.strictObject({
    messages: z.array(z.strictObject({ speaker: z.string(), round: z.int().min(1), text: z.string() })),
    victim: seat.nullable(),
  }),
  WITCH_INFO: z.strictObject({ attacked: seat.nullable() }),
  CHARMED_LIST: z.strictObject({ charmed: z.array(seat) }),
  INFECTED: z.strictObject({ seat }),
  // --- dawn / deaths
  DEATHS: z.strictObject({ deaths: z.array(z.strictObject({ seat, reveal })) }),
  DEATH_CAUSES: z.strictObject({ deaths: z.array(z.strictObject({ seat, causes: z.array(DEATH_CAUSE) })) }),
  NO_DEATHS: z.strictObject({}),
  ELDER_CURSE: z.strictObject({}),
  HUNTER_SHOT: z.strictObject({ hunter: seat, target: seat }),
  HUNTER_NO_SHOT: z.strictObject({ hunter: seat }),
  RAVEN_MARK: z.strictObject({ seat }),
  BEAR: z.strictObject({ growls: z.boolean() }),
  // --- day
  SHERIFF_CANDIDACY: z.strictObject({ seat, run: z.boolean() }),
  SHERIFF_RESULT: z.strictObject({ sheriff: seat.nullable(), reason: z.string() }),
  SHERIFF_CHANGE: z.strictObject({ from: seat, to: seat.nullable() }),
  SPEECH: z.strictObject({
    seat,
    context: z.string(),
    round: z.int().nullable(),
    text: z.string(),
    lean: seat.nullable(),
    claim: z.strictObject({ role, result: z.string().optional() }).nullable(),
  }),
  /** A Challenge (ruleset §9.2): `seat` called out `target` in this discussion speech; the target answers next. */
  CHALLENGE: z.strictObject({ seat, target: seat, round: z.int().min(1) }),
  VOTES: z.strictObject({
    context: z.string(),
    ballots: z.array(z.strictObject({ voter: seat, vote: z.union([seat, z.literal('abstain')]), weight: z.int().min(0) })),
    scores: z.record(z.string(), z.number()),
    abstain: z.number(),
    raven: seat.nullable().optional(),
  }),
  RUNOFF: z.strictObject({ candidates: z.array(seat) }),
  NO_EXECUTION: z.strictObject({ reason: z.string() }),
  EXECUTION: z.strictObject({ seat, scapegoat: z.boolean().optional() }),
  IDIOT_REVEALED: z.strictObject({ seat }),
  SCAPEGOAT_RULING: z.strictObject({ voters: z.array(seat) }),
  SECOND_VOTE: z.strictObject({}),
  DAY_SUMMARY: z.strictObject({
    day: z.int(),
    deaths: z.array(z.unknown()),
    votes: z.array(z.unknown()),
    alive: z.array(seat),
    sheriff: seat.nullable(),
  }),
  // --- end
  ANGEL_RECORDED: z.strictObject({ seat }),
  GAME_OVER: z.strictObject({ winner: z.union([team, z.literal('draw')]), winners: z.array(seat), reason: z.string() }),
  FINAL_REVEAL: z.strictObject({
    seats: z.array(z.strictObject({ seat, role, originalRole: role, team, alive: z.boolean() })),
  }),
  // --- debrief (ruleset §15b)
  DEBRIEF_OPENED: z.strictObject({ rounds: z.int().min(1).max(2) }),
  DEBRIEF_DECLINED: z.strictObject({}),
  DEBRIEF_COMMENT: z.strictObject({ seat, round: z.int().min(1).max(2), text: z.string() }),
  // --- protocol
  REQUEST_OPENED: z.strictObject({ requestId: z.int(), seat: addressee, kind: z.string(), context: z.string() }),
  REQUEST_CLOSED: z.strictObject({ requestId: z.int(), seat: addressee }),
  SEAT_THOUGHTS: z.strictObject({ seat, requestId: z.int(), context: z.string(), reasoning: z.string(), notebook: z.string().nullable() }),
  FALLBACK_USED: z.strictObject({ seat: addressee, requestId: z.int(), context: z.string(), reason: z.string() }),
} as const;

export type EngineEventType = keyof typeof EngineEventPayloads;
export type EnginePayload<T extends EngineEventType> = z.infer<(typeof EngineEventPayloads)[T]>;

/** Validate one event against its payload schema. Returns issue strings (empty when valid). */
export function checkEngineEvent(e: EngineEvent): string[] {
  const schema = (EngineEventPayloads as Record<string, z.ZodType>)[e.type];
  if (!schema) return [`unknown event type ${e.type}`];
  const r = schema.safeParse(e.payload);
  return r.success ? [] : r.error.issues.map((i) => `${e.type}.${i.path.join('.')}: ${i.message}`);
}
