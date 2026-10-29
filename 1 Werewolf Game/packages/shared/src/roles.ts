/**
 * Static role catalogue metadata (WEREWOLF_RULESET.md §10, weights §12).
 * Pure data: the engine's role plugins (M2/M3) implement behaviour and are
 * checked against this catalogue by a registry test.
 */

export const ROLE_IDS = [
  // Village team
  'villager',
  'seer',
  'witch',
  'hunter',
  'protector',
  'cupid',
  'little_girl',
  'elder',
  'village_idiot',
  'scapegoat',
  'fox',
  'knight',
  'two_sisters',
  'raven',
  'stuttering_judge',
  'bear_tamer',
  // Werewolf team
  'werewolf',
  'big_bad_wolf',
  'accursed_wolf_father',
  // Ambiguous / solo
  'white_werewolf',
  'thief',
  'wild_child',
  'wolf_hound',
  'piper',
  'angel',
] as const;

export type RoleId = (typeof ROLE_IDS)[number];

export const TEAMS = ['Village', 'Werewolf', 'Lovers', 'WhiteWolf', 'Piper', 'Angel'] as const;
export type Team = (typeof TEAMS)[number];

/** Starting team; 'Varies' = decided during Night 1 (Thief, Wolf-Hound). */
export type StartingTeam = Team | 'Varies';

export type RoleCategory = 'village' | 'werewolf' | 'solo';

export interface RoleMeta {
  id: RoleId;
  label: string;
  category: RoleCategory;
  startingTeam: StartingTeam;
  wolfNature: boolean;
  /** Unique roles may appear at most once (§12.1). */
  unique: boolean;
  /** Number of cards one "copy" of the role uses (Two Sisters = 2). */
  cardCount: 1 | 2;
  /** Balance weight per card (§10 / §12.2). */
  weight: number;
  /** Counts toward the solo/ambiguous card limit (§12.1). */
  countsAsSolo: boolean;
}

const r = (m: RoleMeta): RoleMeta => m;

export const ROLES: Readonly<Record<RoleId, RoleMeta>> = {
  villager: r({ id: 'villager', label: 'Villager', category: 'village', startingTeam: 'Village', wolfNature: false, unique: false, cardCount: 1, weight: 1, countsAsSolo: false }),
  seer: r({ id: 'seer', label: 'Seer', category: 'village', startingTeam: 'Village', wolfNature: false, unique: true, cardCount: 1, weight: 7, countsAsSolo: false }),
  witch: r({ id: 'witch', label: 'Witch', category: 'village', startingTeam: 'Village', wolfNature: false, unique: true, cardCount: 1, weight: 4, countsAsSolo: false }),
  hunter: r({ id: 'hunter', label: 'Hunter', category: 'village', startingTeam: 'Village', wolfNature: false, unique: true, cardCount: 1, weight: 3, countsAsSolo: false }),
  protector: r({ id: 'protector', label: 'Protector', category: 'village', startingTeam: 'Village', wolfNature: false, unique: true, cardCount: 1, weight: 3, countsAsSolo: false }),
  cupid: r({ id: 'cupid', label: 'Cupid', category: 'village', startingTeam: 'Village', wolfNature: false, unique: true, cardCount: 1, weight: -3, countsAsSolo: false }),
  little_girl: r({ id: 'little_girl', label: 'Little Girl', category: 'village', startingTeam: 'Village', wolfNature: false, unique: true, cardCount: 1, weight: 3, countsAsSolo: false }),
  elder: r({ id: 'elder', label: 'Elder', category: 'village', startingTeam: 'Village', wolfNature: false, unique: true, cardCount: 1, weight: 2, countsAsSolo: false }),
  village_idiot: r({ id: 'village_idiot', label: 'Village Idiot', category: 'village', startingTeam: 'Village', wolfNature: false, unique: true, cardCount: 1, weight: 2, countsAsSolo: false }),
  scapegoat: r({ id: 'scapegoat', label: 'Scapegoat', category: 'village', startingTeam: 'Village', wolfNature: false, unique: true, cardCount: 1, weight: 1, countsAsSolo: false }),
  fox: r({ id: 'fox', label: 'Fox', category: 'village', startingTeam: 'Village', wolfNature: false, unique: true, cardCount: 1, weight: 3, countsAsSolo: false }),
  knight: r({ id: 'knight', label: 'Knight with the Rusty Sword', category: 'village', startingTeam: 'Village', wolfNature: false, unique: true, cardCount: 1, weight: 3, countsAsSolo: false }),
  two_sisters: r({ id: 'two_sisters', label: 'Two Sisters', category: 'village', startingTeam: 'Village', wolfNature: false, unique: true, cardCount: 2, weight: 2, countsAsSolo: false }),
  raven: r({ id: 'raven', label: 'Raven', category: 'village', startingTeam: 'Village', wolfNature: false, unique: true, cardCount: 1, weight: 2, countsAsSolo: false }),
  stuttering_judge: r({ id: 'stuttering_judge', label: 'Stuttering Judge', category: 'village', startingTeam: 'Village', wolfNature: false, unique: true, cardCount: 1, weight: 3, countsAsSolo: false }),
  bear_tamer: r({ id: 'bear_tamer', label: 'Bear Tamer', category: 'village', startingTeam: 'Village', wolfNature: false, unique: true, cardCount: 1, weight: 3, countsAsSolo: false }),
  werewolf: r({ id: 'werewolf', label: 'Werewolf', category: 'werewolf', startingTeam: 'Werewolf', wolfNature: true, unique: false, cardCount: 1, weight: -6, countsAsSolo: false }),
  big_bad_wolf: r({ id: 'big_bad_wolf', label: 'Big Bad Wolf', category: 'werewolf', startingTeam: 'Werewolf', wolfNature: true, unique: true, cardCount: 1, weight: -9, countsAsSolo: false }),
  accursed_wolf_father: r({ id: 'accursed_wolf_father', label: 'Accursed Wolf-Father', category: 'werewolf', startingTeam: 'Werewolf', wolfNature: true, unique: true, cardCount: 1, weight: -9, countsAsSolo: false }),
  white_werewolf: r({ id: 'white_werewolf', label: 'White Werewolf', category: 'solo', startingTeam: 'WhiteWolf', wolfNature: true, unique: true, cardCount: 1, weight: -5, countsAsSolo: true }),
  thief: r({ id: 'thief', label: 'Thief', category: 'solo', startingTeam: 'Varies', wolfNature: false, unique: true, cardCount: 1, weight: -1, countsAsSolo: true }),
  wild_child: r({ id: 'wild_child', label: 'Wild Child', category: 'solo', startingTeam: 'Village', wolfNature: false, unique: true, cardCount: 1, weight: -1, countsAsSolo: true }),
  wolf_hound: r({ id: 'wolf_hound', label: 'Wolf-Hound', category: 'solo', startingTeam: 'Varies', wolfNature: false, unique: true, cardCount: 1, weight: -2, countsAsSolo: true }),
  piper: r({ id: 'piper', label: 'Piper', category: 'solo', startingTeam: 'Piper', wolfNature: false, unique: true, cardCount: 1, weight: -4, countsAsSolo: true }),
  angel: r({ id: 'angel', label: 'Angel', category: 'solo', startingTeam: 'Angel', wolfNature: false, unique: true, cardCount: 1, weight: -2, countsAsSolo: true }),
};

export function isRoleId(x: string): x is RoleId {
  return (ROLE_IDS as readonly string[]).includes(x);
}
