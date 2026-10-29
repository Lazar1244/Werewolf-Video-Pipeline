import { describe, type NameOf } from '@ww/projector';
import type { EngineEvent, EnginePayload } from '@ww/shared';

/* Terminal colours (disabled when NO_COLOR is set). */
const plain = process.env['NO_COLOR'] !== undefined;
const ESC = String.fromCharCode(27); // written as a code point: no literal control character in source
const c = (code: string) => (s: string) => (plain ? s : `${ESC}[${code}m${s}${ESC}[0m`);
export const dim = c('2');
export const bold = c('1');
export const red = c('31');
export const green = c('32');
export const yellow = c('33');
export const blue = c('36');
export const magenta = c('35');

export interface PrintOptions {
  /** Show each seat's inner monologue and private night actions (spectator view). */
  thoughts: boolean;
  /** Show private channel messages (pack council, lovers, sisters). */
  channels: boolean;
}

/** One line per event, in the spectator's view. Returns the lines (empty when nothing to show). */
export function renderEvent(e: EngineEvent, name: NameOf, o: PrintOptions): string[] {
  switch (e.type) {
    case 'SPEECH': {
      const p = e.payload as EnginePayload<'SPEECH'>;
      const lean = p.lean === null ? '' : dim(`  [suspects ${name(p.lean)}]`);
      const claim = p.claim ? dim(`  [claims ${p.claim.role}${p.claim.result ? `: ${p.claim.result}` : ''}]`) : '';
      const answers = p.context === 'challenge_answer' ? dim(' (answers the challenge)') : '';
      return [`${bold(name(p.seat))}${answers}: ${p.text}${lean}${claim}`];
    }
    case 'SEAT_THOUGHTS': {
      if (!o.thoughts) return [];
      const p = e.payload as EnginePayload<'SEAT_THOUGHTS'>;
      if (!p.reasoning.trim()) return [];
      return [dim(`   ${name(p.seat)} thinks: ${p.reasoning}`)];
    }
    case 'COUNCIL_MSG': {
      if (!o.channels) return [];
      const p = e.payload as EnginePayload<'COUNCIL_MSG'>;
      const proposal = p.proposed_target === null ? 'no target yet' : `proposes ${name(p.proposed_target)}`;
      return [red(`   [pack] ${name(p.seat)}: ${p.message} `) + dim(`(${proposal}${p.ready ? ', ready' : ''})`)];
    }
    case 'CHANNEL_MSG': {
      if (!o.channels) return [];
      const p = e.payload as EnginePayload<'CHANNEL_MSG'>;
      return [magenta(`   [${p.channel}] ${name(p.seat)}: ${p.message}`)];
    }
    case 'NIGHT_ACTION': {
      if (!o.thoughts) return [];
      const p = e.payload as EnginePayload<'NIGHT_ACTION'>;
      const what = p.choice ?? (p.targets ? p.targets.map(name).join(' + ') : p.target !== undefined && p.target !== null ? name(p.target) : p.heal !== undefined ? `heal=${p.heal}, poison=${p.poison === null || p.poison === undefined ? 'none' : name(p.poison)}` : 'nothing');
      return [dim(`   ${name(p.seat)} [${p.role}] → ${what}`)];
    }
    case 'FALLBACK_USED': {
      if (!o.thoughts) return [];
      const p = e.payload as EnginePayload<'FALLBACK_USED'>;
      return [dim(`   (no usable answer from ${p.seat === 0 ? 'the host' : name(p.seat)} for ${p.context}: ${p.reason} — the engine chose for them)`)];
    }
    case 'REQUEST_OPENED':
    case 'REQUEST_CLOSED':
    case 'NIGHT_STEP_START':
      return [];
  }
  const text = describe(e, name);
  if (!text) return [];
  // Private notices are worded for their recipient ("You are the Seer"), so name them here.
  if (e.vis.kind === 'seats') {
    if (!o.thoughts) return [];
    return [dim(`   [to ${e.vis.seats.map(name).join(', ')}] ${text}`)];
  }
  switch (e.type) {
    case 'PHASE_START':
      return ['', bold(blue(`— ${text} —`))];
    case 'DEATHS':
    case 'EXECUTION':
    case 'HUNTER_SHOT':
      return [red(text)];
    case 'GAME_OVER':
      return ['', bold(green(text))];
    case 'FINAL_REVEAL':
      return [green(text), ''];
    default:
      return [yellow(text)];
  }
}

export function printEvents(events: readonly EngineEvent[], name: NameOf, o: PrintOptions): void {
  for (const e of events) for (const line of renderEvent(e, name, o)) console.log(line);
}
