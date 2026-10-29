import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RulesSchema, layerRules, resolveSentinels, type GameConfig, type RoleId, type RulesOverride } from '@ww/shared';
import { loadPromptPack } from '../src/pack';

export const ROOT = join(import.meta.dirname, '../../..');
const DEFAULT_RULES = RulesSchema.parse(JSON.parse(readFileSync(join(ROOT, 'config/rules/default.json'), 'utf8')));
export const NAMES = ['Alba', 'Bram', 'Cora', 'Dario', 'Elin', 'Fenn', 'Greta', 'Hugo', 'Ines', 'Jonas'];
export const PACK = loadPromptPack(join(ROOT, 'prompts'));

export function makeCfg(cards: RoleId[], rules: RulesOverride = {}, extra: Partial<GameConfig> = {}): GameConfig {
  const seats = cards.includes('thief') ? cards.length - 2 : cards.length;
  return {
    seed: 'ctx-seed',
    seats,
    cards,
    rules: resolveSentinels(layerRules(DEFAULT_RULES, rules), seats),
    names: NAMES,
    maskNames: ['GPT', 'Claude'],
    humanSlots: [],
    fixedDeal: true,
    ...extra,
  };
}
