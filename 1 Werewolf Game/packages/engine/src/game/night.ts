import type { AnyDecision, DecisionOf, RoleId, SeatId, Team } from '@ww/shared';
import { ROLES } from '@ww/shared';
import { chance, pick, shuffle } from '../rng';
import { maskNames } from '../text';
import { PUBLIC, SPECTATOR, ask, emit, living, livingNeighbours, livingSeats, seatOf, toSeats } from './core';
import { initialUsesOf, powered } from './roles';
import { changeTeam, evaluateLovers } from './teams';
import type { Game, RequestDraft, SeatState } from './types';

/** Everything collected during the night and resolved at Dawn (ruleset §8). */
export interface NightActions {
  victim: SeatId | null;
  infect: boolean;
  bbwVictim: SeatId | null;
  wwVictim: SeatId | null;
  protectedSeat: SeatId | null;
  healed: boolean;
  poisoned: SeatId | null;
  poisonByTeam: Team | null;
  /** The Little Girl chose to spy tonight. */
  lgSpy: SeatId | null;
}

/**
 * A night step provider (ARCHITECTURE.md §5.4). Steps run in `order` (ruleset §7.2).
 * Consecutive active steps sharing a `band` form ONE parallel group: each contributes a
 * request draft and applies its decision afterwards, in step order.
 */
interface NightStep {
  order: number;
  id: string;
  band?: string;
  draft?: (g: Game) => RequestDraft | null;
  apply?: (g: Game, draft: RequestDraft, d: AnyDecision, na: NightActions) => void;
  run?: (g: Game, na: NightActions) => void;
}

const N1 = (g: Game) => g.night === 1;

/** Seer / Fox detection label for `seer_mode = role` (§10 Seer). */
function roleLabel(s: SeatState): string {
  if (s.infectedOn !== null) return `${s.role} (infected)`;
  if (s.convertedWolf) return `${s.role} (wolf)`;
  return s.role;
}

const NIGHT_STEPS: NightStep[] = [
  { order: 1, id: 'thief', run: (g) => N1(g) && thiefStep(g) },
  { order: 2, id: 'wolf_hound', run: (g) => N1(g) && wolfHoundStep(g) },
  { order: 3, id: 'cupid', run: (g) => N1(g) && cupidStep(g) },
  { order: 4, id: 'lovers', run: (g) => N1(g) && loversStep(g) },
  { order: 5, id: 'wild_child', run: (g) => N1(g) && wildChildStep(g) },
  { order: 6, id: 'sisters', run: sistersStep },
  {
    order: 7,
    id: 'protector',
    band: 'n7_10',
    draft: (g) => {
      const p = powered(g, 'protector');
      if (!p) return null;
      const targets = livingSeats(g).filter((n) => n !== g.lastProtected && (g.cfg.rules.protector_self || n !== p.seat));
      return { seat: p.seat, kind: 'target', context: 'protector', legal: { targets, allowNone: true }, optional: true };
    },
    apply: (g, r, d, na) => {
      const t = (d as DecisionOf<'target'>).target;
      na.protectedSeat = t;
      g.lastProtected = t;
      emit(g, 'NIGHT_ACTION', { role: 'protector', seat: r.seat as SeatId, target: t }, toSeats([r.seat as SeatId]));
    },
  },
  {
    order: 8,
    id: 'seer',
    band: 'n7_10',
    draft: (g) => {
      const s = powered(g, 'seer');
      if (!s) return null;
      return { seat: s.seat, kind: 'target', context: 'seer', legal: { targets: livingSeats(g).filter((n) => n !== s.seat), allowNone: true }, optional: true };
    },
    apply: (g, r, d) => {
      const t = (d as DecisionOf<'target'>).target;
      if (t === null) return;
      const target = seatOf(g, t);
      const result = g.cfg.rules.seer_mode === 'role' ? roleLabel(target) : target.wolfNature ? 'werewolf' : 'not_werewolf';
      emit(g, 'SEER_RESULT', { target: t, result }, toSeats([r.seat as SeatId]));
    },
  },
  {
    order: 9,
    id: 'fox',
    band: 'n7_10',
    draft: (g) => {
      const f = powered(g, 'fox');
      if (!f) return null;
      return { seat: f.seat, kind: 'target', context: 'fox', legal: { targets: livingSeats(g).filter((n) => n !== f.seat), allowNone: true }, optional: true };
    },
    apply: (g, r, d) => {
      const t = (d as DecisionOf<'target'>).target;
      if (t === null) return;
      const group = [t, ...livingNeighbours(g, t)];
      const wolfAmong = group.some((n) => seatOf(g, n).wolfNature);
      const fox = seatOf(g, r.seat as SeatId);
      if (!wolfAmong) fox.powersActive = false;
      emit(g, 'FOX_RESULT', { target: t, wolfAmong, lostPower: !wolfAmong }, toSeats([fox.seat]));
    },
  },
  {
    order: 10,
    id: 'little_girl',
    band: 'n7_10',
    draft: (g) => {
      const lg = powered(g, 'little_girl');
      // an infected Little Girl attends the council instead of spying
      if (!lg || lg.wolfNature) return null;
      return { seat: lg.seat, kind: 'choice', context: 'little_girl', legal: { choices: ['spy', 'sleep'] }, optional: true };
    },
    apply: (g, r, d, na) => {
      const spy = (d as DecisionOf<'choice'>).choice === 'spy';
      if (spy) na.lgSpy = r.seat as SeatId;
      emit(g, 'NIGHT_ACTION', { role: 'little_girl', seat: r.seat as SeatId, choice: spy ? 'spy' : 'sleep' }, toSeats([r.seat as SeatId]));
    },
  },
  { order: 11, id: 'pack_council', run: (g, na) => { na.victim = council(g, na); } },
  { order: 12, id: 'wolf_father', run: wolfFatherStep },
  { order: 13, id: 'big_bad_wolf', run: bigBadWolfStep },
  { order: 14, id: 'white_werewolf', run: whiteWerewolfStep },
  { order: 15, id: 'witch', run: witchStep },
  { order: 16, id: 'raven', run: ravenStep },
  { order: 17, id: 'piper', run: piperStep },
  { order: 18, id: 'charmed', run: charmedStep },
];

/** Night k (ruleset §7). Collects actions in wake order; resolution happens at Dawn. */
export function night(g: Game): NightActions {
  g.phase = 'night';
  emit(g, 'PHASE_START', { phase: 'night', night: g.night }, PUBLIC);
  const na: NightActions = { victim: null, infect: false, bbwVictim: null, wwVictim: null, protectedSeat: null, healed: false, poisoned: null, poisonByTeam: null, lgSpy: null };
  const steps = [...NIGHT_STEPS].sort((x, y) => x.order - y.order);
  let protectorActed = false;
  for (let i = 0; i < steps.length; ) {
    const step = steps[i]!;
    if (!step.band) {
      step.run!(g, na);
      i++;
      continue;
    }
    const band: { step: NightStep; draft: RequestDraft }[] = [];
    let j = i;
    for (; j < steps.length && steps[j]!.band === step.band; j++) {
      const s = steps[j]!;
      const d = s.draft!(g);
      if (d) {
        emit(g, 'NIGHT_STEP_START', { step: s.order, role: s.id }, SPECTATOR);
        band.push({ step: s, draft: { ...d, step: s.order } });
        if (s.id === 'protector') protectorActed = true;
      }
    }
    const res = ask(g, band.map((b) => b.draft));
    band.forEach((b, k) => b.step.apply!(g, b.draft, res[k]!.decision, na));
    i = j;
  }
  if (!protectorActed) g.lastProtected = null;
  return na;
}

const stepStart = (g: Game, step: number, role: string) => emit(g, 'NIGHT_STEP_START', { step, role }, SPECTATOR);

// ---------------------------------------------------------------- N1 steps

/** Step 1: Thief keeps its card (becoming a Villager) or takes an extra (§7.2, §10). */
function thiefStep(g: Game): void {
  const thief = g.seats.find((s) => s.alive && s.role === 'thief');
  if (!thief || g.thiefExtras.length !== 2) return;
  stepStart(g, 1, 'thief');
  const extras = g.thiefExtras as [RoleId, RoleId];
  emit(g, 'THIEF_OFFER', { extras }, toSeats([thief.seat]));
  const forced = extras.every((r) => ROLES[r].wolfNature);
  const choices = forced ? ['extra1', 'extra2'] : ['keep', 'extra1', 'extra2'];
  const [r] = ask(g, [{ seat: thief.seat, kind: 'choice', context: 'thief', legal: { choices }, optional: !forced, step: 1 }]);
  const choice = (r!.decision as DecisionOf<'choice'>).choice;
  const newRole: RoleId = choice === 'extra1' ? extras[0] : choice === 'extra2' ? extras[1] : 'villager';
  if (choice !== 'keep') g.thiefExtras[choice === 'extra1' ? 0 : 1] = 'thief';
  const meta = ROLES[newRole];
  thief.role = newRole;
  thief.originalRole = newRole;
  thief.uses = initialUsesOf(newRole);
  emit(g, 'NIGHT_ACTION', { role: 'thief', seat: thief.seat, choice }, toSeats([thief.seat]));
  changeTeam(g, thief, { team: meta.startingTeam === 'Varies' ? 'Village' : meta.startingTeam, wolfNature: meta.wolfNature }, 'thief');
}

/** Step 2: Wolf-Hound chooses a side, told nothing about the others first. */
function wolfHoundStep(g: Game): void {
  const h = g.seats.find((s) => s.alive && s.role === 'wolf_hound');
  if (!h) return;
  stepStart(g, 2, 'wolf_hound');
  const [r] = ask(g, [{ seat: h.seat, kind: 'choice', context: 'wolf_hound', legal: { choices: ['Village', 'Werewolf'] }, optional: false, step: 2 }]);
  const choice = (r!.decision as DecisionOf<'choice'>).choice;
  emit(g, 'NIGHT_ACTION', { role: 'wolf_hound', seat: h.seat, choice }, toSeats([h.seat]));
  if (choice === 'Werewolf') {
    h.convertedWolf = true;
    changeTeam(g, h, { team: 'Werewolf', wolfNature: true }, 'wolf_hound');
  } else {
    changeTeam(g, h, { team: 'Village' }, 'wolf_hound');
  }
}

/** Step 3: Cupid links two distinct living players (self allowed). */
function cupidStep(g: Game): void {
  const c = g.seats.find((s) => s.alive && s.role === 'cupid');
  if (!c) return;
  stepStart(g, 3, 'cupid');
  const targets = livingSeats(g);
  const [r] = ask(g, [{ seat: c.seat, kind: 'pair', context: 'cupid', legal: { targets }, optional: false, step: 3 }]);
  const [a, b] = (r!.decision as DecisionOf<'pair'>).targets;
  seatOf(g, a).loverId = b;
  seatOf(g, b).loverId = a;
  g.cupid = c.seat;
  emit(g, 'NIGHT_ACTION', { role: 'cupid', seat: c.seat, targets: [a, b].sort((x, y) => x - y) }, toSeats([c.seat]));
}

/** Step 4: Lovers learn each other, team evaluation, one private message each (lower seat first). */
function loversStep(g: Game): void {
  const lovers = g.seats.filter((s) => s.loverId !== null).map((s) => s.seat).sort((x, y) => x - y);
  if (lovers.length !== 2) return;
  stepStart(g, 4, 'lovers');
  for (const n of lovers) {
    const partner = seatOf(g, seatOf(g, n).loverId!);
    emit(g, 'LOVER_INFO', g.cfg.rules.lovers_see_role ? { partner: partner.seat, partnerRole: partner.role } : { partner: partner.seat }, toSeats([n]));
  }
  evaluateLovers(g);
  channel(g, 'lovers', lovers, 1, lovers[0]!, 'lovers_channel', 4);
}

/** Step 5: Wild Child chooses a role model (a living player other than itself). */
function wildChildStep(g: Game): void {
  const w = g.seats.find((s) => s.alive && s.role === 'wild_child');
  if (!w) return;
  stepStart(g, 5, 'wild_child');
  const [r] = ask(g, [{ seat: w.seat, kind: 'target', context: 'wild_child', legal: { targets: livingSeats(g).filter((n) => n !== w.seat), allowNone: false }, optional: false, step: 5 }]);
  w.roleModel = (r!.decision as DecisionOf<'target'>).target;
  emit(g, 'NIGHT_ACTION', { role: 'wild_child', seat: w.seat, target: w.roleModel }, toSeats([w.seat]));
}

/** Step 6: Two Sisters learn each other (N1) and share a channel while both are alive and powered. */
function sistersStep(g: Game): void {
  const sisters = g.seats.filter((s) => s.role === 'two_sisters').map((s) => s.seat).sort((x, y) => x - y);
  if (sisters.length !== 2) return;
  const [a, b] = sisters as [SeatId, SeatId];
  const both = [a, b].map((n) => seatOf(g, n));
  if (!both.every((s) => s.alive && s.powersActive)) return;
  stepStart(g, 6, 'sisters');
  if (N1(g)) {
    emit(g, 'SISTER_INFO', { sister: b }, toSeats([a]));
    emit(g, 'SISTER_INFO', { sister: a }, toSeats([b]));
  }
  const first = g.night % 2 === 1 ? a : b;
  channel(g, 'sisters', sisters, g.cfg.rules.sister_messages, first, 'sisters_channel', 6);
}

/** A bounded private channel: `perSeat` messages each, alternating, starting with `first`. */
function channel(g: Game, label: 'lovers' | 'sisters', seats: SeatId[], perSeat: number, first: SeatId, context: 'lovers_channel' | 'sisters_channel', step: number): void {
  const order = seats[0] === first ? seats : [...seats].reverse();
  for (let round = 1; round <= perSeat; round++) {
    for (const n of order) {
      if (!seatOf(g, n).alive) continue;
      const [r] = ask(g, [{ seat: n, kind: 'message', context, legal: {}, words: g.cfg.rules.words.channel_message, optional: true, channel: label, step, round, maxRounds: perSeat }]);
      const message = (r!.decision as DecisionOf<'message'>).message;
      if (message) emit(g, 'CHANNEL_MSG', { channel: label, seat: n, round, message }, toSeats(seats, label));
    }
  }
}

// ---------------------------------------------------------------- the pack

/** Pack council (ruleset §7.3). Returns the victim V, or null (no legal victim, or a skip). */
export function council(g: Game, na: NightActions): SeatId | null {
  const pack = living(g).filter((s) => s.wolfNature).map((s) => s.seat);
  const victims = living(g).filter((s) => !s.wolfNature).map((s) => s.seat);
  if (pack.length === 0) return null;
  stepStart(g, 11, 'pack');
  if (victims.length === 0) {
    emit(g, 'COUNCIL_SKIPPED', { reason: 'no legal victim' }, SPECTATOR);
    return null;
  }
  const allowSkip = g.cfg.rules.wolves_may_skip;
  const packVis = toSeats(pack, 'pack');
  emit(g, 'PACK_INFO', { pack: pack.map((n) => ({ seat: n, role: seatOf(g, n).role === 'white_werewolf' ? 'werewolf' : seatOf(g, n).role })) }, packVis);
  // Pack Leader: the first night the pack exists, its lowest seat; then the next living participant to the left.
  const prev = g.packLeader;
  const leader = prev === null ? pack[0]! : (pack.find((n) => n > prev) ?? pack[0]!);
  g.packLeader = leader;

  // Little Girl catch (§7.3)
  const lg = na.lgSpy;
  let caught = false;
  const rollCatch = () => {
    if (lg === null || caught) return;
    if (chance(g.rng, g.cfg.rules.little_girl_catch)) {
      caught = true;
      emit(g, 'LITTLE_GIRL_CAUGHT', { seat: lg }, packVis);
    }
  };
  const transcript: { seat: SeatId; round: number; text: string }[] = [];

  let victim: SeatId | null;
  if (pack.length === 1) {
    rollCatch(); // single wolf: rolled before its decision
    const [r] = ask(g, [{ seat: pack[0]!, kind: 'target', context: 'wolf_kill', legal: { targets: victims, allowNone: allowSkip }, optional: allowSkip, step: 11, channel: 'pack' }]);
    victim = (r!.decision as DecisionOf<'target'>).target;
    if (victim === null && !allowSkip) victim = pick(g.rng, victims);
  } else {
    emit(g, 'PACK_LEADER', { leader }, packVis);
    const start = pack.indexOf(leader);
    const order = [...pack.slice(start), ...pack.slice(0, start)];
    let maxRounds = g.cfg.rules.wolf_council_max_rounds;
    let locked: { target: SeatId | null } | null = null;
    for (let round = 1; round <= maxRounds && locked === null; round++) {
      const turns: DecisionOf<'council_turn'>[] = [];
      for (const w of order) {
        const [r] = ask(g, [
          { seat: w, kind: 'council_turn', context: 'council', legal: { targets: victims, allowNone: true }, words: g.cfg.rules.words.channel_message, optional: false, channel: 'pack', step: 11, round, maxRounds },
        ]);
        const d = r!.decision as DecisionOf<'council_turn'>;
        turns.push(d);
        transcript.push({ seat: w, round, text: d.message });
        emit(g, 'COUNCIL_MSG', { seat: w, round, message: d.message, proposed_target: d.proposed_target, ready: d.ready }, packVis);
      }
      const first = turns[0]!.proposed_target;
      const agreed = turns.every((t) => t.proposed_target === first && t.ready) && (first !== null || allowSkip);
      if (round === 1) {
        rollCatch();
        if (caught) {
          maxRounds = Math.max(maxRounds, 2); // at least one more round; round 1's lock is void
          continue;
        }
      }
      if (agreed) locked = { target: first };
    }
    if (locked !== null) victim = locked.target;
    else {
      const res = ask(
        g,
        order.map((w) => ({ seat: w, kind: 'council_ballot' as const, context: 'council_ballot' as const, legal: { targets: victims, allowNone: allowSkip }, optional: false, channel: 'pack' as const, step: 11 })),
      );
      const ballots = order.map((w, i) => ({ seat: w, target: (res[i]!.decision as DecisionOf<'council_ballot'>).target }));
      emit(g, 'COUNCIL_BALLOTS', { ballots: [...ballots].sort((a, b) => a.seat - b.seat) }, packVis);
      const counts = new Map<SeatId | null, number>();
      for (const b of ballots) counts.set(b.target, (counts.get(b.target) ?? 0) + 1);
      const max = Math.max(...counts.values());
      const top = [...counts.entries()].filter(([, c]) => c === max).map(([t]) => t);
      if (top.length === 1) victim = top[0]!;
      else {
        const tiedTargets = top.filter((t): t is SeatId => t !== null).sort((a, b) => a - b);
        const [r] = ask(g, [{ seat: leader, kind: 'target', context: 'pack_tiebreak', legal: { targets: tiedTargets, allowNone: top.includes(null) }, optional: false, channel: 'pack', step: 11 }]);
        victim = (r!.decision as DecisionOf<'target'>).target;
        if (victim === null && !top.includes(null)) victim = pick(g.rng, tiedTargets);
      }
    }
  }
  emit(g, 'COUNCIL_RESULT', { victim }, packVis);

  // The spying Little Girl: nothing if caught; otherwise the masked transcript and V.
  if (lg !== null && !caught && seatOf(g, lg).alive) {
    const labels = shuffle(g.rng, pack.map((_, i) => `Wolf ${String.fromCharCode(65 + i)}`));
    const labelOf = new Map(pack.map((n, i) => [n, labels[i]!]));
    const packNames = pack.map((n) => seatOf(g, n).name);
    emit(
      g,
      'LITTLE_GIRL_TRANSCRIPT',
      { messages: transcript.map((m) => ({ speaker: labelOf.get(m.seat)!, round: m.round, text: maskNames(m.text, packNames, '[a wolf]') })), victim },
      toSeats([lg]),
    );
  }
  return victim;
}

/** Step 12: the Accursed Wolf-Father may infect V instead of killing (once per game). */
function wolfFatherStep(g: Game, na: NightActions): void {
  const f = g.seats.find((s) => s.alive && s.role === 'accursed_wolf_father' && s.wolfNature && s.powersActive && (s.uses.infect ?? 0) > 0);
  if (!f || na.victim === null) return;
  stepStart(g, 12, 'wolf_father');
  const [r] = ask(g, [{ seat: f.seat, kind: 'choice', context: 'wolf_father', legal: { choices: ['infect', 'kill'] }, optional: true, channel: 'pack', step: 12 }]);
  na.infect = (r!.decision as DecisionOf<'choice'>).choice === 'infect';
  emit(g, 'NIGHT_ACTION', { role: 'accursed_wolf_father', seat: f.seat, choice: na.infect ? 'infect' : 'kill' }, toSeats([f.seat]));
}

/** Step 13: the Big Bad Wolf kills one more non-wolf while no wolf-nature seat has died. */
function bigBadWolfStep(g: Game, na: NightActions): void {
  const w = g.seats.find((s) => s.alive && s.role === 'big_bad_wolf' && s.wolfNature && s.powersActive);
  if (!w || g.wolfHasDied) return;
  const targets = living(g).filter((s) => !s.wolfNature && s.seat !== na.victim).map((s) => s.seat);
  if (targets.length === 0) return;
  stepStart(g, 13, 'big_bad_wolf');
  const [r] = ask(g, [{ seat: w.seat, kind: 'target', context: 'big_bad_wolf', legal: { targets, allowNone: true }, optional: true, step: 13 }]);
  na.bbwVictim = (r!.decision as DecisionOf<'target'>).target;
  emit(g, 'NIGHT_ACTION', { role: 'big_bad_wolf', seat: w.seat, target: na.bbwVictim }, toSeats([w.seat]));
}

/** Step 14: the White Werewolf may kill another Pack member on even nights. */
function whiteWerewolfStep(g: Game, na: NightActions): void {
  if (g.night % 2 !== 0) return;
  const w = powered(g, 'white_werewolf');
  if (!w) return;
  const targets = living(g).filter((s) => s.wolfNature && s.seat !== w.seat).map((s) => s.seat);
  if (targets.length === 0) return;
  stepStart(g, 14, 'white_werewolf');
  const [r] = ask(g, [{ seat: w.seat, kind: 'target', context: 'white_werewolf', legal: { targets, allowNone: true }, optional: true, step: 14 }]);
  na.wwVictim = (r!.decision as DecisionOf<'target'>).target;
  emit(g, 'NIGHT_ACTION', { role: 'white_werewolf', seat: w.seat, target: na.wwVictim }, toSeats([w.seat]));
}

/** Step 15: the Witch is told V (only) and may heal and/or poison. Skipped with no legal action. */
function witchStep(g: Game, na: NightActions): void {
  const witch = powered(g, 'witch');
  if (!witch) return;
  const canHeal = (witch.uses.heal ?? 0) > 0 && na.victim !== null && (na.victim !== witch.seat || g.cfg.rules.witch_self_heal);
  const poisonTargets = (witch.uses.poison ?? 0) > 0 ? livingSeats(g).filter((n) => n !== witch.seat) : [];
  if (!canHeal && poisonTargets.length === 0) return;
  stepStart(g, 15, 'witch');
  emit(g, 'WITCH_INFO', { attacked: na.victim }, toSeats([witch.seat]));
  const [r] = ask(g, [{ seat: witch.seat, kind: 'witch', context: 'witch', legal: { canHeal, healTarget: na.victim, poisonTargets }, optional: true, step: 15 }]);
  const d = r!.decision as DecisionOf<'witch'>;
  if (d.heal && canHeal) {
    na.healed = true;
    witch.uses.heal = 0;
  }
  if (d.poison !== null && poisonTargets.includes(d.poison)) {
    na.poisoned = d.poison;
    na.poisonByTeam = witch.team; // the Witch's team at the moment of the action (§8.3)
    witch.uses.poison = 0;
  }
  emit(g, 'NIGHT_ACTION', { role: 'witch', seat: witch.seat, heal: na.healed, poison: na.poisoned }, toSeats([witch.seat]));
}

/** Step 16: the Raven may mark a player (+2 votes tomorrow; announced at Dawn). */
function ravenStep(g: Game): void {
  const r0 = powered(g, 'raven');
  if (!r0) return;
  stepStart(g, 16, 'raven');
  const [r] = ask(g, [{ seat: r0.seat, kind: 'target', context: 'raven', legal: { targets: livingSeats(g).filter((n) => n !== r0.seat), allowNone: true }, optional: true, step: 16 }]);
  g.ravenMark = (r!.decision as DecisionOf<'target'>).target;
  emit(g, 'NIGHT_ACTION', { role: 'raven', seat: r0.seat, target: g.ravenMark }, toSeats([r0.seat]));
}

const piperActive = (g: Game) => g.seats.find((s) => s.alive && s.role === 'piper' && s.powersActive && s.team === 'Piper');

/** Step 17: the Piper charms up to 2 living, uncharmed players other than itself. */
function piperStep(g: Game): void {
  const p = piperActive(g);
  if (!p) return;
  const targets = living(g).filter((s) => !s.charmed && s.seat !== p.seat).map((s) => s.seat);
  if (targets.length === 0) return;
  stepStart(g, 17, 'piper');
  const [r] = ask(g, [{ seat: p.seat, kind: 'multi', context: 'piper', legal: { targets, min: 0, max: Math.min(2, targets.length) }, optional: true, step: 17 }]);
  const charmed = (r!.decision as DecisionOf<'multi'>).targets;
  for (const n of charmed) seatOf(g, n).charmed = true;
  emit(g, 'NIGHT_ACTION', { role: 'piper', seat: p.seat, targets: [...charmed].sort((a, b) => a - b) }, toSeats([p.seat]));
}

/** Step 18: every charmed living player learns who is charmed (while an active Piper lives). */
function charmedStep(g: Game): void {
  if (!piperActive(g)) return;
  const charmed = living(g).filter((s) => s.charmed).map((s) => s.seat);
  if (charmed.length === 0) return;
  stepStart(g, 18, 'charmed');
  emit(g, 'CHARMED_LIST', { charmed }, toSeats(charmed, 'charmed'));
}
