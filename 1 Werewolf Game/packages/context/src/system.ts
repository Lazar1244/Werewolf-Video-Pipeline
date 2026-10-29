import { ROLES, type ResolvedRules, type RoleId, type Team } from '@ww/shared';
import { packFile, PromptPackError, render, type PromptPack } from './pack';
import type { Wording } from './schema';

/**
 * L0 (ruleset §14.2): the rules digest for this composition plus the truth, injection and
 * output policies. It contains no seat-specific content, so it is byte-identical for every
 * seat and constant for the whole game (the longest cacheable prefix).
 */
export function roleVars(rules: ResolvedRules): Record<string, string> {
  return {
    seer_result:
      rules.seer_mode === 'alignment' ? 'only whether that player is a Werewolf (has wolf nature) or not' : "that player's exact role",
    witch_self: rules.witch_self_heal ? ' (even herself)' : ' (but not herself)',
    protector_self: rules.protector_self ? '; may protect themself' : '; may not protect themself',
    catch_pct: `${Math.round(rules.little_girl_catch * 100)}%`,
    elder_curse: rules.elder_curse
      ? 'If the village itself kills the Elder (execution, the Witch’s poison or the Hunter’s shot), every Village-team player loses their special powers for the rest of the game.'
      : '',
    angel_rule: rules.angel_ends_game ? ' The game then ends at once.' : ' The game then continues, and the Angel still counts as a winner.',
  };
}

export function teamsInPlay(cards: readonly RoleId[]): Team[] {
  const t: Team[] = ['Village', 'Werewolf'];
  if (cards.includes('cupid')) t.push('Lovers');
  if (cards.includes('white_werewolf')) t.push('WhiteWolf');
  if (cards.includes('piper')) t.push('Piper');
  if (cards.includes('angel')) t.push('Angel');
  return t;
}

export function compositionText(cards: readonly RoleId[], extras: number): string {
  const counts = new Map<RoleId, number>();
  for (const c of cards) counts.set(c, (counts.get(c) ?? 0) + 1);
  const parts = [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([r, n]) => (n > 1 ? `${ROLES[r].label} ×${n}` : ROLES[r].label));
  return parts.join(', ') + (extras ? `. ${extras} of these cards are set aside (the Thief's extras) and not in play.` : '.');
}

/** The Challenge rule (ruleset §9.2) for the day rules; empty when the game has none (e.g. games frozen before it). */
export function challengeRule(rules: ResolvedRules): string {
  const n = rules.challenges_per_player ?? 0;
  if (n <= 0) return '';
  const times = n === 1 ? 'Once per game' : `${n} times per game`;
  return `- Challenge: ${times}, a player may use a discussion speech to challenge one living player. The challenged player must answer right away, before the next speaker (at most ${rules.words.challenge_answer ?? 60} words); this answer does not replace their own turn. Challenges are public.`;
}

/** The pack folder with a wording's texts (`rule.md` for the system prompt, then one guidance file per team). */
export const wordingDir = (w: Wording): string => (w === 'thoughts' ? 'reasoning/thoughts' : 'reasoning');

const WORDING_FILES = ['rule', 'village', 'wolf', 'solo'];

/**
 * The wordings this pack has, the default first. A pack frozen before 2026-10-21 has one, written into its own
 * `system.md` and `output.md`: "inner_voice" (that morning) or "reasoning" (before); the schema field follows it.
 */
export function wordingsOf(pack: PromptPack): Wording[] {
  const has = (w: Wording) => WORDING_FILES.every((f) => `${wordingDir(w)}/${f}.md` in pack.files);
  if (has('inner_voice') && has('thoughts')) return ['inner_voice', 'thoughts'];
  // a current pack (the field is a placeholder) with a wording file missing is broken, not frozen
  if (pack.files['output.md']?.includes('{{thoughts_field}}')) throw new PromptPackError('prompt pack is missing a file of prompts/reasoning/ or prompts/reasoning/thoughts/');
  return [pack.files['output.md']?.includes('Field order: "inner_voice" first') ? 'inner_voice' : 'reasoning'];
}

export function buildSystemPrompt(pack: PromptPack, cards: readonly RoleId[], extras: number, rules: ResolvedRules, wording?: Wording): string {
  const rv = roleVars(rules);
  const wordings = wordingsOf(pack);
  const w = wording ?? wordings[0]!;
  if (!wordings.includes(w)) throw new PromptPackError(`prompt pack has no "${w}" wording`);
  // a frozen pack has its one wording's line in system.md itself (and no placeholder for it)
  const rule = wordings.length > 1 ? packFile(pack, `${wordingDir(w)}/rule.md`).trim() : '';
  const roles = [...new Set(cards)].sort().map((r) => render(packFile(pack, `roles/${r}.md`), rv).trim());
  const teams = teamsInPlay(cards).map((t) => render(packFile(pack, `teams/${t}.md`), rv).trim());
  const text = render(packFile(pack, 'system.md'), {
    reveal_rule:
      rules.reveal_on_death === 'full'
        ? 'When a player dies, their role is revealed to everyone.'
        : rules.reveal_on_death === 'team'
          ? 'When a player dies, only their team is revealed.'
          : 'When a player dies, nothing about their role is revealed.',
    discussion_rounds: rules.discussion_rounds,
    sheriff_weight: rules.sheriff_enabled ? " (the Sheriff's vote counts double, even when abstaining)" : '',
    abstain_rule: rules.abstain_blocks_execution ? ', unless that score is not higher than the total weight of abstentions (then nobody is executed)' : '',
    challenge_rule: challengeRule(rules),
    sheriff_rule: rules.sheriff_enabled
      ? '- Sheriff: on Day 1, before the discussion, players may run for Sheriff; candidates give a short speech and everyone votes. The Sheriff\'s vote counts double, the discussion starts to the Sheriff\'s left, and a dying Sheriff names a successor.'
      : '',
    max_days: rules.max_days,
    stall_cycles: rules.stall_cycles,
    wolves_skip_rule: rules.wolves_may_skip ? ' The pack may also choose to kill nobody.' : '',
    composition: compositionText(cards, extras),
    roles: roles.join('\n'),
    teams: teams.join('\n'),
    thoughts_rule: rule,
    thoughts_field: w,
  });
  return text.replace(/\n{3,}/g, '\n\n').replace(/\n\n(?=- )/g, '\n');
}
