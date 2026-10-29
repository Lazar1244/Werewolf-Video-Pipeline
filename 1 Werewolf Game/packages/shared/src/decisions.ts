import { z } from 'zod';
import { ROLE_IDS } from './roles';
import type { ChannelLabel, SeatId } from './events';

/**
 * Decision contracts (ARCHITECTURE.md §4.3, ruleset §13).
 *
 * Every AI decision may carry `reasoning` (the inner monologue, ruleset §14.3) and
 * `notebook`. Humans omit both. Unknown extra fields are stripped (models add them).
 */

export const DECISION_KINDS = [
  'sheriff_run',
  'speech',
  'vote',
  'council_turn',
  'council_ballot',
  'target',
  'witch',
  'choice',
  'pair',
  'multi',
  'message',
] as const;
export type DecisionKind = (typeof DECISION_KINDS)[number];

/** What a `speech` request is for; selects the word limit. `challenge_answer`: the immediate answer to a Challenge (ruleset §9.2). */
export const SPEECH_CONTEXTS = ['discussion', 'sheriff', 'rebuttal', 'defence', 'last_words', 'judge_round', 'debrief_comment', 'debrief_reply', 'challenge_answer'] as const;
export type SpeechContext = (typeof SPEECH_CONTEXTS)[number];

export const VOTE_CONTEXTS = ['day', 'runoff', 'second_vote', 'second_runoff', 'sheriff', 'sheriff_runoff'] as const;
export type VoteContext = (typeof VOTE_CONTEXTS)[number];

export const TARGET_CONTEXTS = [
  'protector',
  'seer',
  'fox',
  'wolf_kill',
  'big_bad_wolf',
  'white_werewolf',
  'raven',
  'wild_child',
  'hunter_shot',
  'sheriff_successor',
  'pack_tiebreak',
] as const;
export type TargetContext = (typeof TARGET_CONTEXTS)[number];

/** `choice` decisions pick one string from `legal.choices`. */
export const CHOICE_CONTEXTS = ['thief', 'wolf_hound', 'little_girl', 'wolf_father', 'debrief_accept'] as const;
export type ChoiceContext = (typeof CHOICE_CONTEXTS)[number];

export type RequestContext =
  | SpeechContext
  | VoteContext
  | TargetContext
  | ChoiceContext
  | 'sheriff_run'
  | 'council'
  | 'council_ballot'
  | 'witch'
  | 'cupid'
  | 'piper'
  | 'scapegoat_ruling'
  | 'lovers_channel'
  | 'sisters_channel';

const seat = z.int().min(1).max(10);
const thoughts = {
  /** Inner monologue: written first, private, shown to spectators (ruleset §14.3). */
  reasoning: z.string().max(20_000).optional(),
  notebook: z.string().max(20_000).optional(),
};

export const DecisionSchemas = {
  sheriff_run: z.object({ ...thoughts, run: z.boolean() }),
  speech: z.object({
    ...thoughts,
    speech: z.string().max(20_000),
    lean: seat.nullable().optional(),
    /** Optional self-tagged claim. An unknown role never rejects the speech: it becomes null. */
    claim: z
      .object({ role: z.enum(ROLE_IDS), result: z.string().max(20_000).optional() })
      .nullable()
      .optional()
      .catch(null),
    /**
     * Challenge (ruleset §9.2): call out this living player, who must answer right after this speech. Only in
     * discussion speeches (and Challenge answers, with `challenge_in_answer`) while the speaker has a Challenge left
     * (`legal.challengeTargets`). A malformed value never
     * rejects the speech (it becomes null); one that is not usable right now is ignored by the engine.
     */
    challenge: seat.nullable().optional().catch(null),
  }),
  /** `second_vote` is the Stuttering Judge's secret flag (only legal for the Judge, first ballot). */
  vote: z.object({ ...thoughts, vote: z.union([seat, z.literal('abstain')]), second_vote: z.boolean().optional() }),
  council_turn: z.object({
    ...thoughts,
    message: z.string().max(20_000),
    proposed_target: seat.nullable(),
    ready: z.boolean(),
  }),
  /** null = skip the kill (only legal with `wolves_may_skip`). */
  council_ballot: z.object({ ...thoughts, target: seat.nullable() }),
  target: z.object({ ...thoughts, target: seat.nullable() }),
  witch: z.object({ ...thoughts, heal: z.boolean(), poison: seat.nullable() }),
  choice: z.object({ ...thoughts, choice: z.string().max(40) }),
  pair: z.object({ ...thoughts, targets: z.tuple([seat, seat]) }),
  multi: z.object({ ...thoughts, targets: z.array(seat).max(10) }),
  message: z.object({ ...thoughts, message: z.string().max(20_000) }),
} satisfies Record<DecisionKind, z.ZodType>;

export type DecisionOf<K extends DecisionKind> = z.infer<(typeof DecisionSchemas)[K]>;
export type AnyDecision = { [K in DecisionKind]: DecisionOf<K> }[DecisionKind];

/** Legal options attached to a request; the engine validates against them. */
export interface LegalOptions {
  /** Targets for vote / target / council_* / pair / multi decisions. */
  targets?: SeatId[];
  /** `target` may be null (optional ability) / vote may abstain / council may skip. */
  allowNone?: boolean;
  /** Valid `lean` values for speeches (null always allowed). */
  leanTargets?: SeatId[];
  /** Valid `challenge` values for a discussion speech or a Challenge answer; absent when none may be made now. */
  challengeTargets?: SeatId[];
  /** Witch: may heal the attacked player (healTarget). */
  canHeal?: boolean;
  healTarget?: SeatId | null;
  poisonTargets?: SeatId[];
  /** `choice` decisions: the allowed values. */
  choices?: string[];
  /** `multi` decisions: allowed count range. */
  min?: number;
  max?: number;
  /** Vote: the Judge may set `second_vote`. */
  secondVote?: boolean;
}

export interface DecisionRequest {
  requestId: number;
  groupId: number;
  /** 0 = host pseudo-addressee (post-game only). */
  seat: SeatId | 0;
  kind: DecisionKind;
  context: RequestContext;
  legal: LegalOptions;
  /** Word limit for the main text field, if any. */
  words?: number;
  optional: boolean;
  channel?: ChannelLabel;
  /** Night step number (ruleset §7.2) for night requests; orders parallel groups canonically. */
  step?: number;
  /** For round-based talk (discussion, council, channels): this round and the planned number of rounds. */
  round?: number;
  maxRounds?: number;
  day: number;
  night: number;
}
