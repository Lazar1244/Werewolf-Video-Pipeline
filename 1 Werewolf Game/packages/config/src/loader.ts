import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { z } from 'zod';
import {
  AppConfigSchema,
  CompositionSchema,
  ModelsFileSchema,
  NamesFileSchema,
  RostersFileSchema,
  RulesSchema,
  layerRules,
  resolveSentinels,
  validateComposition,
  type AppConfig,
  type Composition,
  type ModelProfile,
  type ResolvedRules,
  type Rules,
  type RulesOverride,
  RulesOverrideSchema,
} from '@ww/shared';

/** Fully validated contents of the `config/` directory (ARCHITECTURE.md §8). */
export interface LoadedConfig {
  dir: string;
  app: AppConfig;
  profiles: ModelProfile[];
  profilesByAlias: ReadonlyMap<string, ModelProfile>;
  rosters: Record<string, string[]>;
  rules: Rules;
  compositions: ReadonlyMap<string, Composition>;
  names: string[];
  warnings: string[];
}

export interface ConfigIssue {
  file: string;
  path: string;
  message: string;
}

export class ConfigError extends Error {
  constructor(public readonly issues: ConfigIssue[]) {
    super(
      `Invalid configuration (${issues.length} issue${issues.length === 1 ? '' : 's'}):\n` +
        issues.map((i) => `  - ${i.file}${i.path ? ` → ${i.path}` : ''}: ${i.message}`).join('\n'),
    );
    this.name = 'ConfigError';
  }
}

/**
 * Load and validate every config file. Throws ConfigError listing *all* problems
 * (with file and JSON path) so the server can refuse to start with a precise message.
 */
export function loadConfig(configDir: string): LoadedConfig {
  const issues: ConfigIssue[] = [];
  const warnings: string[] = [];

  const read = <S extends z.ZodType>(rel: string, schema: S): z.infer<S> | undefined => {
    const file = join(configDir, rel);
    if (!existsSync(file)) {
      issues.push({ file: rel, path: '', message: 'file is missing' });
      return undefined;
    }
    let raw: unknown;
    try {
      // Strip a UTF-8 BOM (Windows editors / PowerShell 5.1 write one by default).
      raw = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    } catch (e) {
      issues.push({ file: rel, path: '', message: `invalid JSON: ${(e as Error).message}` });
      return undefined;
    }
    const res = schema.safeParse(raw);
    if (!res.success) {
      for (const iss of res.error.issues) issues.push({ file: rel, path: formatPath(iss.path), message: iss.message });
      return undefined;
    }
    return res.data;
  };

  const app = read('app.json', AppConfigSchema);
  const models = read('models.json', ModelsFileSchema);
  const rostersFile = read('rosters.json', RostersFileSchema);
  const rules = read('rules/default.json', RulesSchema);
  const namesFile = read('names.json', NamesFileSchema);

  // Compositions: one file per preset, file name must equal its id.
  const compositions = new Map<string, Composition>();
  const compDir = join(configDir, 'compositions');
  if (!existsSync(compDir)) {
    issues.push({ file: 'compositions/', path: '', message: 'directory is missing' });
  } else {
    for (const f of readdirSync(compDir).filter((x) => x.endsWith('.json')).sort()) {
      const rel = `compositions/${f}`;
      const comp = read(rel, CompositionSchema);
      if (!comp) continue;
      if (comp.id !== basename(f, '.json')) {
        issues.push({ file: rel, path: 'id', message: `id "${comp.id}" must match the file name "${basename(f, '.json')}"` });
        continue;
      }
      if (compositions.has(comp.id)) {
        issues.push({ file: rel, path: 'id', message: `duplicate composition id "${comp.id}"` });
        continue;
      }
      compositions.set(comp.id, comp);
    }
    if (compositions.size === 0) issues.push({ file: 'compositions/', path: '', message: 'no composition presets found' });
  }

  // ---- Cross-file checks -------------------------------------------------
  const profilesByAlias = new Map<string, ModelProfile>();
  if (models) {
    models.profiles.forEach((p, i) => {
      if (profilesByAlias.has(p.alias)) {
        issues.push({ file: 'models.json', path: `profiles.${i}.alias`, message: `duplicate alias "${p.alias}"` });
      }
      profilesByAlias.set(p.alias, p);
      if (p.reasoning.enabled && p.reasoning.style === 'max_tokens' && p.reasoning.maxTokens === 0) {
        issues.push({ file: 'models.json', path: `profiles.${i}.reasoning.maxTokens`, message: 'must be > 0 when reasoning is enabled with style "max_tokens"' });
      }
    });
    if (![...profilesByAlias.values()].some((p) => p.enabled)) {
      issues.push({ file: 'models.json', path: 'profiles', message: 'at least one profile must be enabled' });
    }
  }

  if (rostersFile && models) {
    for (const [name, aliases] of Object.entries(rostersFile.rosters)) {
      aliases.forEach((a, i) => {
        const p = profilesByAlias.get(a);
        if (!p) issues.push({ file: 'rosters.json', path: `rosters.${name}.${i}`, message: `unknown model alias "${a}"` });
        else if (!p.enabled) warnings.push(`rosters.json: roster "${name}" uses disabled model "${a}"`);
      });
    }
  }

  if (app && models && app.defaultFallbackAlias !== null) {
    const p = profilesByAlias.get(app.defaultFallbackAlias);
    if (!p) issues.push({ file: 'app.json', path: 'defaultFallbackAlias', message: `unknown model alias "${app.defaultFallbackAlias}"` });
    else if (!p.enabled) issues.push({ file: 'app.json', path: 'defaultFallbackAlias', message: `model "${app.defaultFallbackAlias}" is disabled` });
  }
  if (app && app.disconnectMaxMs < app.disconnectGraceMs) {
    issues.push({ file: 'app.json', path: 'disconnectMaxMs', message: 'must be >= disconnectGraceMs' });
  }

  if (rules) {
    for (const [id, comp] of compositions) {
      const rel = `compositions/${id}.json`;
      let resolved: ResolvedRules;
      try {
        resolved = resolveGameRules(rules, comp);
      } catch (e) {
        issues.push({ file: rel, path: 'ruleOverrides', message: (e as Error).message });
        continue;
      }
      const report = validateComposition(comp, resolved.reveal_on_death);
      for (const err of report.errors) issues.push({ file: rel, path: 'cards', message: err });
      for (const w of report.warnings) warnings.push(`${rel}: ${w}`);
    }
  }

  if (issues.length > 0 || !app || !models || !rostersFile || !rules || !namesFile) throw new ConfigError(issues);

  return {
    dir: configDir,
    app,
    profiles: models.profiles,
    profilesByAlias,
    rosters: rostersFile.rosters,
    rules,
    compositions,
    names: namesFile.names,
    warnings,
  };
}

/**
 * Layer rules for one game: defaults < composition overrides < lobby overrides,
 * re-validate the whole object, then resolve per-game sentinels.
 */
export function resolveGameRules(
  defaults: Rules,
  composition: Pick<Composition, 'seats' | 'ruleOverrides'>,
  lobbyOverride?: RulesOverride,
): ResolvedRules {
  if (lobbyOverride) {
    const chk = RulesOverrideSchema.safeParse(lobbyOverride);
    if (!chk.success) throw new Error(`invalid lobby rule override: ${chk.error.issues.map((i) => `${formatPath(i.path)}: ${i.message}`).join('; ')}`);
  }
  const layered = layerRules(defaults, composition.ruleOverrides, lobbyOverride);
  const res = RulesSchema.safeParse(layered);
  if (!res.success) {
    throw new Error(`layered rules invalid: ${res.error.issues.map((i) => `${formatPath(i.path)}: ${i.message}`).join('; ')}`);
  }
  return resolveSentinels(res.data, composition.seats);
}

function formatPath(path: readonly PropertyKey[]): string {
  return path.map((p) => String(p)).join('.');
}
