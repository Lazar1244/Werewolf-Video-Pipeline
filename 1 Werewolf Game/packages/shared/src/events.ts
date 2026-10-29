import { z } from 'zod';

/**
 * Identifiers and event envelopes (ARCHITECTURE.md §4).
 * Concrete event payload schemas are added per event type from M2 on.
 */

export const SeatIdSchema = z.int().min(1).max(10);
export type SeatId = z.infer<typeof SeatIdSchema>;

export const SlotIdSchema = z.int().min(1).max(10);
export type SlotId = z.infer<typeof SlotIdSchema>;

/** 0 = host pseudo-addressee (post-game host decisions only). */
export const AddresseeSchema = z.union([z.literal(0), SeatIdSchema]);
export type Addressee = z.infer<typeof AddresseeSchema>;

export const ChannelLabelSchema = z.enum(['pack', 'sisters', 'lovers', 'charmed']);
export type ChannelLabel = z.infer<typeof ChannelLabelSchema>;

/** Engine-event visibility: recipients are resolved by the engine at emit time. */
export const EngineVisibilitySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('public') }),
  z.strictObject({
    kind: z.literal('seats'),
    seats: z.array(SeatIdSchema).min(1),
    channel: ChannelLabelSchema.optional(),
  }),
  z.strictObject({ kind: z.literal('spectator') }),
]);
export type EngineVisibility = z.infer<typeof EngineVisibilitySchema>;

export const PhaseSchema = z.enum(['setup', 'night', 'dawn', 'day', 'dusk', 'over', 'debrief']);
export type Phase = z.infer<typeof PhaseSchema>;

export const GameTimeSchema = z.strictObject({
  phase: PhaseSchema,
  day: z.int().min(0),
  night: z.int().min(0),
  step: z.int().min(0).optional(),
});
export type GameTime = z.infer<typeof GameTimeSchema>;

export interface EngineEvent<TType extends string = string, TPayload = unknown> {
  /** Contiguous per game, engine-generated. Never exposed to clients. */
  eseq: number;
  at: GameTime;
  type: TType;
  payload: TPayload;
  vis: EngineVisibility;
}

export const MetaVisibilitySchema = z.enum(['host_safe', 'host_full', 'spectator']);
export type MetaVisibility = z.infer<typeof MetaVisibilitySchema>;

export const META_EVENT_TYPES = [
  'GAME_PAUSED',
  'GAME_RESUMED',
  'COST_UPDATE',
  'SEAT_REMAP',
  'SEAT_DOWNGRADE',
  'FORCED_START',
  'HUMAN_CONNECTED',
  'HUMAN_DISCONNECTED',
  'LOCK_OPENED',
  'DEBRIEF_OFFERED',
  'DEBRIEF_ACCEPTED',
  'DEBRIEF_DECLINED',
  'LINK_REISSUED',
  'ENGINE_ERROR',
] as const;
export type MetaEventType = (typeof META_EVENT_TYPES)[number];

export interface MetaEvent<TPayload = unknown> {
  mseq: number;
  wallTime: string;
  type: MetaEventType;
  payload: TPayload;
  vis: MetaVisibility;
}

export const NO_ANSWER_REASONS = ['timeout', 'invalid', 'provider_error', 'disconnected', 'aborted', 'forced'] as const;
export type NoAnswerReason = (typeof NO_ANSWER_REASONS)[number];

/** Shape check for answers crossing the API boundary (the decision itself is checked per kind). */
export const AnswerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('decision'), decision: z.unknown() }),
  z.object({ kind: z.literal('no_answer'), reason: z.enum(NO_ANSWER_REASONS) }),
]);

export type Answer<TDecision = unknown> =
  | { kind: 'decision'; decision: TDecision }
  | { kind: 'no_answer'; reason: NoAnswerReason };
