import { ROLE_IDS, type DecisionRequest } from '@ww/shared';

/**
 * Per-request strict JSON Schema (ARCHITECTURE.md §7.4): legal targets become enums, every
 * property is required, optional values use a nullable type (`type: [T, "null"]`, with `null`
 * also inside the enum), `additionalProperties: false`, and no keywords that strict modes
 * reject (word counts and list sizes are enforced after the call by zod and the engine).
 */
export type JsonSchema = Record<string, unknown>;

const str = (description?: string): JsonSchema => ({ type: 'string', ...(description ? { description } : {}) });
const nullableStr = (description?: string): JsonSchema => ({ type: ['string', 'null'], ...(description ? { description } : {}) });

/** An enum of seat numbers; `orNull` adds null to both the type and the enum. */
function seatEnum(seats: readonly number[], orNull = false): JsonSchema {
  const values: (number | null)[] = [...seats];
  if (orNull || seats.length === 0) values.push(null);
  const type = orNull || seats.length === 0 ? ['integer', 'null'] : 'integer';
  return { type, enum: values };
}

function obj(props: Record<string, JsonSchema>, nullable = false): JsonSchema {
  return { type: nullable ? ['object', 'null'] : 'object', properties: props, required: Object.keys(props), additionalProperties: false };
}

/**
 * How the inner monologue (ruleset §14.3) is asked for; the name is also its JSON field. The newest Claude models
 * refuse some requests that ask for it (Anthropic's anti-distillation filter, finish reason `content_filter`), and
 * each refuses a different wording: Opus 5.5 any "reasoning" field and some "thoughts" requests, Fable 5.1 every
 * "inner_voice" request (2026-10-21). A model starts with "inner_voice" and switches after a refusal (the controller).
 * The texts are `prompts/reasoning/*.md` and `prompts/reasoning/thoughts/*.md`. "reasoning" is only for prompt packs
 * frozen before 2026-10-21, which ask for that field (`wordingsOf`).
 */
export type Wording = 'inner_voice' | 'thoughts' | 'reasoning';

export function requestSchema(req: DecisionRequest, wording: Wording = 'inner_voice'): JsonSchema {
  const L = req.legal;
  const targets = L.targets ?? [];
  const head: Record<string, JsonSchema> = {
    // the controller stores this field as the decision's `reasoning`. The description is the same in every wording
    // and is part of the texts that passed live tests on Claude Opus and Fable (2026-10-21): re-test before editing it.
    [wording]: str(
      "Your character's inner voice about the game: what they privately think right now about the other players, the night, the votes and what to do next. In character, a few sentences; shown to viewers as part of the story.",
    ),
    notebook: nullableStr('Your private notes for later (replaces the previous notebook); null keeps it.'),
  };
  switch (req.kind) {
    case 'sheriff_run':
      return obj({ ...head, run: { type: 'boolean' } });
    case 'speech':
      return obj({
        ...head,
        speech: str(),
        lean: seatEnum(L.leanTargets ?? [], true),
        claim: obj({ role: { type: 'string', enum: [...ROLE_IDS] }, result: nullableStr() }, true),
        // only offered while the speaker still has a Challenge (ruleset §9.2)
        ...(L.challengeTargets?.length ? { challenge: seatEnum(L.challengeTargets, true) } : {}),
      });
    case 'vote': {
      const vote: JsonSchema = { type: ['integer', 'string'], enum: [...targets, 'abstain'] };
      return obj({ ...head, vote, ...(L.secondVote ? { second_vote: { type: 'boolean' } } : {}) });
    }
    case 'council_turn':
      return obj({ ...head, message: str(), proposed_target: seatEnum(targets, true), ready: { type: 'boolean' } });
    case 'council_ballot':
    case 'target':
      return obj({ ...head, target: seatEnum(targets, L.allowNone === true) });
    case 'witch':
      return obj({ ...head, heal: { type: 'boolean' }, poison: seatEnum(L.poisonTargets ?? [], true) });
    case 'choice':
      return obj({ ...head, choice: { type: 'string', enum: [...(L.choices ?? [])] } });
    case 'pair':
    case 'multi':
      return obj({ ...head, targets: { type: 'array', items: seatEnum(targets) } });
    case 'message':
      return obj({ ...head, message: str() });
  }
}
