import type { EnginePayload, EngineEventType, RoleId, SeatId } from '@ww/shared';
import { ROLES } from '@ww/shared/roles';
import type { ViewEntry } from './project';

/**
 * Plain-English text for engine entries. Used for the engine entries of AI transcripts
 * (ruleset §14.2 L3/L4) and for the CLI log. Player-written text is never included here:
 * speeches and messages are rendered as quoted, attributed data by the caller.
 */
type P<T extends EngineEventType> = EnginePayload<T>;
export type NameOf = (seat: SeatId) => string;

export const roleLabel = (r: RoleId): string => ROLES[r].label;

function revealText(r: P<'DEATHS'>['deaths'][number]['reveal']): string {
  if (!r) return 'role not revealed';
  if ('role' in r) return `was the ${roleLabel(r.role)}${r.infected ? ' (infected by the werewolves)' : ''}`;
  return `was on team ${r.team}`;
}

const list = (xs: string[]) => (xs.length === 0 ? 'nobody' : xs.length === 1 ? xs[0]! : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);

/** Text for one entry, or null for entries that carry no information worth showing. */
export function describe(e: { type: string; payload: unknown; at: ViewEntry['at'] }, name: NameOf, about?: SeatId | 'group' | null): string | null {
  const n = name;
  const v = voice(about ?? null, name);
  switch (e.type) {
    case 'GAME_START': {
      const p = e.payload as P<'GAME_START'>;
      const comp = [...p.composition].sort().map(roleLabel);
      return `The game begins with ${p.seats.length} players: ${list(p.seats.map((s) => s.name))}. Cards in the game: ${comp.join(', ')}${p.extras ? ` (${p.extras} of them are set aside and not in play)` : ''}.`;
    }
    case 'PHASE_START': {
      const p = e.payload as P<'PHASE_START'>;
      if (p.phase === 'night') return `Night ${e.at.night} falls.`;
      if (p.phase === 'dawn') return `Dawn ${e.at.night}.`;
      if (p.phase === 'day') return `Day ${e.at.day} begins.`;
      return `Dusk ${e.at.day}.`;
    }
    case 'DEATHS':
      return (e.payload as P<'DEATHS'>).deaths.map((d) => `${n(d.seat)} died and ${revealText(d.reveal)}.`).join(' ');
    case 'NO_DEATHS':
      return 'Nobody died.';
    case 'ELDER_CURSE':
      return 'The village killed its Elder: every Village-team player has lost their special powers.';
    case 'HUNTER_SHOT': {
      const p = e.payload as P<'HUNTER_SHOT'>;
      return `The Hunter ${n(p.hunter)} shot ${n(p.target)}.`;
    }
    case 'RAVEN_MARK':
      return `The Raven has marked ${n((e.payload as P<'RAVEN_MARK'>).seat)}: +2 votes against them today.`;
    case 'BEAR':
      return (e.payload as P<'BEAR'>).growls ? "The Bear Tamer's bear growls." : "The Bear Tamer's bear is silent.";
    case 'SHERIFF_CANDIDACY': {
      const p = e.payload as P<'SHERIFF_CANDIDACY'>;
      return p.run ? `${n(p.seat)} runs for Sheriff.` : null;
    }
    case 'SHERIFF_RESULT': {
      const p = e.payload as P<'SHERIFF_RESULT'>;
      return p.sheriff ? `${n(p.sheriff)} is elected Sheriff (their vote counts double).` : `No Sheriff was elected (${p.reason}).`;
    }
    case 'SHERIFF_CHANGE': {
      const p = e.payload as P<'SHERIFF_CHANGE'>;
      return p.to ? `The Sheriff's badge passes from ${n(p.from)} to ${n(p.to)}.` : `The Sheriff's badge of ${n(p.from)} is destroyed.`;
    }
    case 'VOTES': {
      const p = e.payload as P<'VOTES'>;
      const what = VOTE_LABEL[p.context] ?? p.context;
      const ballots = p.ballots.map((b) => `${n(b.voter)} → ${b.vote === 'abstain' ? 'abstain' : n(b.vote)}${b.weight > 1 ? ` (x${b.weight})` : ''}`);
      const scores = Object.entries(p.scores)
        .sort((a, b) => b[1] - a[1])
        .map(([s, c]) => `${n(Number(s))}: ${c}`);
      return `${what} results. Ballots: ${ballots.join('; ') || 'none'}. Totals: ${scores.join(', ') || 'no votes'}; abstentions: ${p.abstain}${p.raven ? ` (includes the Raven's +2 on ${n(p.raven)})` : ''}.`;
    }
    case 'RUNOFF':
      return `Tie: runoff between ${list((e.payload as P<'RUNOFF'>).candidates.map(n))}.`;
    case 'NO_EXECUTION':
      return `No one is executed (${(e.payload as P<'NO_EXECUTION'>).reason}).`;
    case 'EXECUTION': {
      const p = e.payload as P<'EXECUTION'>;
      return p.scapegoat ? `The vote stayed tied: the Scapegoat ${n(p.seat)} is executed instead.` : `${n(p.seat)} is executed by the village.`;
    }
    case 'IDIOT_REVEALED':
      return `${n((e.payload as P<'IDIOT_REVEALED'>).seat)} is revealed as the Village Idiot: spared, but can no longer vote.`;
    case 'SCAPEGOAT_RULING':
      return `The Scapegoat rules that only ${list((e.payload as P<'SCAPEGOAT_RULING'>).voters.map(n))} may vote tomorrow.`;
    case 'SECOND_VOTE':
      return 'The Stuttering Judge has called a second vote today.';
    case 'CHALLENGE': {
      const p = e.payload as P<'CHALLENGE'>;
      return `${n(p.seat)} challenges ${n(p.target)}, who must answer right now.`;
    }
    case 'ANGEL_RECORDED':
      return `${n((e.payload as P<'ANGEL_RECORDED'>).seat)} was the Angel and has won; the game goes on.`;
    case 'GAME_OVER': {
      const p = e.payload as P<'GAME_OVER'>;
      return p.winner === 'draw' ? `The game ends in a draw (${p.reason}).` : `Game over: team ${p.winner} wins (${p.reason}). Winners: ${list(p.winners.map(n))}.`;
    }
    case 'FINAL_REVEAL':
      return (e.payload as P<'FINAL_REVEAL'>).seats.map((s) => `${n(s.seat)}: ${roleLabel(s.role)} (${s.team}${s.alive ? ', alive' : ''})`).join('; ');
    // --- private notices
    case 'ROLE_ASSIGNED': {
      const p = e.payload as P<'ROLE_ASSIGNED'>;
      return `${v.You} ${v.is} the ${roleLabel(p.role)} (team ${p.team}).`;
    }
    case 'ROLE_CHANGED': {
      const p = e.payload as P<'ROLE_CHANGED'>;
      return `${v.Your} role is now ${roleLabel(p.role)}, team ${p.team}${p.wolfNature ? ', with wolf nature' : ''} (${changeLabel(p.reason, v)}).`;
    }
    case 'THIEF_OFFER': {
      const p = e.payload as P<'THIEF_OFFER'>;
      return `The two set-aside cards are: ${roleLabel(p.extras[0])} and ${roleLabel(p.extras[1])}.`;
    }
    case 'PACK_JOINED': {
      const p = e.payload as P<'PACK_JOINED'>;
      return `${n(p.seat)} (${roleLabel(p.role)}) has joined the pack. The pack is now: ${list(p.pack.map(n))}.`;
    }
    case 'PACK_INFO':
      return `${v.Your} pack: ${list((e.payload as P<'PACK_INFO'>).pack.map((w) => `${n(w.seat)} (${roleLabel(w.role)})`))}.`;
    case 'PACK_LEADER':
      return `Pack leader tonight: ${n((e.payload as P<'PACK_LEADER'>).leader)}.`;
    case 'COUNCIL_BALLOTS':
      return `Pack ballots: ${(e.payload as P<'COUNCIL_BALLOTS'>).ballots.map((b) => `${n(b.seat)} → ${b.target === null ? 'no kill' : n(b.target)}`).join('; ')}.`;
    case 'COUNCIL_RESULT': {
      const v = (e.payload as P<'COUNCIL_RESULT'>).victim;
      return v === null ? 'The pack kills nobody tonight.' : `The pack's victim tonight: ${n(v)}.`;
    }
    case 'LITTLE_GIRL_CAUGHT':
      return `The pack caught the Little Girl spying: it is ${n((e.payload as P<'LITTLE_GIRL_CAUGHT'>).seat)}.`;
    case 'LITTLE_GIRL_TRANSCRIPT': {
      const p = e.payload as P<'LITTLE_GIRL_TRANSCRIPT'>;
      const msgs = p.messages.map((m) => `${m.speaker}: ${JSON.stringify(m.text)}`).join(' | ');
      return `${v.You} spied on the wolves. ${msgs ? `${v.You} overheard: ${msgs}. ` : ''}Their victim: ${p.victim === null ? 'nobody' : n(p.victim)}.`;
    }
    case 'LOVER_INFO': {
      const p = e.payload as P<'LOVER_INFO'>;
      return `Cupid made ${v.you} fall in love with ${n(p.partner)}${p.partnerRole ? ` (the ${roleLabel(p.partnerRole)})` : ''}. If one of ${v.other ? 'them' : 'you'} dies, the other dies of heartbreak.`;
    }
    case 'SISTER_INFO':
      return `${v.Your} sister is ${n((e.payload as P<'SISTER_INFO'>).sister)}.`;
    case 'SEER_RESULT': {
      const p = e.payload as P<'SEER_RESULT'>;
      return `${v.Your} vision: ${n(p.target)} is ${SEER_LABEL[p.result] ?? p.result}.`;
    }
    case 'FOX_RESULT': {
      const p = e.payload as P<'FOX_RESULT'>;
      return `${v.Your} sniffing around ${n(p.target)}: ${p.wolfAmong ? 'there IS a werewolf among them and their neighbours' : 'no werewolf there'}${p.lostPower ? `. ${v.You} ${v.has} lost ${v.their} power` : ''}.`;
    }
    case 'WITCH_INFO': {
      const a = (e.payload as P<'WITCH_INFO'>).attacked;
      return a === null ? 'Tonight nobody was attacked by the pack.' : `Tonight the pack attacked ${n(a)}.`;
    }
    case 'CHARMED_LIST':
      return `The Piper's charmed players: ${list((e.payload as P<'CHARMED_LIST'>).charmed.map(n))}.`;
    case 'INFECTED':
      return `${v.You} ${v.was} infected by the Accursed Wolf-Father: ${v.you} now ${v.other ? 'belongs' : 'belong'} to the werewolves (keeping ${v.their} role and powers).`;
    case 'NIGHT_ACTION': {
      const p = e.payload as P<'NIGHT_ACTION'>;
      const parts: string[] = [];
      if (p.target !== undefined) parts.push(`target ${p.target === null ? 'nobody' : n(p.target)}`);
      if (p.targets) parts.push(`targets ${list(p.targets.map(n))}`);
      if (p.choice) parts.push(`choice "${p.choice}"`);
      if (p.heal !== undefined) parts.push(p.heal ? 'used the healing potion' : 'no heal');
      if (p.poison !== undefined) parts.push(p.poison ? `poisoned ${n(p.poison)}` : 'no poison');
      return `${v.Your} night action: ${parts.join(', ')}.`;
    }
    default:
      return null;
  }
}

/**
 * The same notice, told about its owner instead of to them. A private notice is written in the
 * second person ("You are the Seer"), which is right on that player's own screen and wrong on a
 * spectator's; `recipients` comes from the entry itself, so this never has to guess who was told.
 * An entry addressed to a whole channel (the pack, the Lovers, the sisters) is already written in
 * the third person, and an entry addressed to the reader is left exactly as they should read it.
 */
export function describeFor(e: { type: string; payload: unknown; at: ViewEntry['at'] }, name: NameOf, viewer: SeatId | null, recipients?: readonly SeatId[]): string | null {
  if (!recipients || recipients.length === 0) return describe(e, name);
  if (viewer !== null && recipients.includes(viewer)) return describe(e, name); // the reader's own
  // one owner is named; a whole channel (a pack, a pair of Lovers) is spoken of as a group
  return describe(e, name, recipients.length === 1 ? recipients[0]! : 'group');
}

/**
 * Who a private notice is about. Built with no seat it reads as it was written, to its owner;
 * built with a seat the same sentence is re-told about that player.
 */
interface Voice {
  You: string;
  you: string;
  Your: string;
  your: string;
  their: string;
  is: string;
  was: string;
  has: string;
  /** True when the notice is being told about someone other than the reader. */
  other: boolean;
}

function voice(about: SeatId | 'group' | null, name: NameOf): Voice {
  if (about === null) return { You: 'You', you: 'you', Your: 'Your', your: 'your', their: 'your', is: 'are', was: 'were', has: 'have', other: false };
  if (about === 'group') return { You: 'They', you: 'they', Your: 'The', your: 'the', their: 'their', is: 'are', was: 'were', has: 'have', other: false };
  const who = name(about);
  return { You: who, you: who, Your: `${who}'s`, your: `${who}'s`, their: 'their', is: 'is', was: 'was', has: 'has', other: true };
}

const changeLabel = (reason: P<'ROLE_CHANGED'>['reason'], v: Voice): string =>
  ({
    thief: `${v.you} took a set-aside card`,
    wolf_hound: `${v.their} Wolf-Hound choice`,
    infected: 'infection',
    wild_child: `${v.their} role model died`,
    lovers: `${v.their} love crosses team lines, so the two Lovers now win together`,
    cupid_reverted: 'both Lovers are dead',
    angel: 'the Angel did not die in the first round',
  })[reason];

const VOTE_LABEL: Record<string, string> = {
  day: 'Execution vote',
  runoff: 'Runoff vote',
  second_vote: 'Second vote',
  second_runoff: 'Second-vote runoff',
  sheriff: 'Sheriff election',
  sheriff_runoff: 'Sheriff runoff',
};

const SEER_LABEL: Record<string, string> = {
  werewolf: 'a WEREWOLF',
  not_werewolf: 'not a werewolf',
};
