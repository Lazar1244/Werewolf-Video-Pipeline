import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, loadSecrets, parseDotEnv, resolveGameRules, secretWarnings } from '../src';

const REAL_CONFIG = join(import.meta.dirname, '../../../config');

const temps: string[] = [];
function copyConfig(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ww-config-'));
  temps.push(dir);
  cpSync(REAL_CONFIG, dir, { recursive: true });
  return dir;
}
function editJson(dir: string, rel: string, fn: (j: any) => void) {
  const f = join(dir, rel);
  const j = JSON.parse(readFileSync(f, 'utf8'));
  fn(j);
  writeFileSync(f, JSON.stringify(j));
}
function issuesOf(dir: string) {
  try {
    loadConfig(dir);
  } catch (e) {
    if (e instanceof ConfigError) return e.issues;
    throw e;
  }
  return [];
}

afterEach(() => {
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
});

describe('loadConfig on the shipped config/', () => {
  it('loads without errors or warnings', () => {
    const cfg = loadConfig(REAL_CONFIG);
    expect(cfg.warnings).toEqual([]);
    expect(cfg.profiles.length).toBeGreaterThanOrEqual(5);
    // the classic tables (their ids are what `ww play --preset` uses) plus the recommended modes
    expect([...cfg.compositions.keys()]).toEqual(expect.arrayContaining(['chaos-10', 'classic-10', 'classic-5', 'classic-6', 'classic-7', 'classic-8', 'classic-9']));
    expect(cfg.compositions.size).toBeGreaterThanOrEqual(20);
    // every roster lists only enabled models (mistral-small is parked: its provider rate-limits us)
    expect(cfg.rosters['cheap-mixed']!.length).toBeGreaterThanOrEqual(5);
    for (const aliases of Object.values(cfg.rosters)) for (const a of aliases) expect(cfg.profilesByAlias.get(a)?.enabled).toBe(true);
    expect(cfg.names.length).toBeGreaterThanOrEqual(10);
  });

  it('resolves per-game rules for a composition', () => {
    const cfg = loadConfig(REAL_CONFIG);
    const r = resolveGameRules(cfg.rules, cfg.compositions.get('classic-7')!, { discussion_rounds: 3 });
    expect(r).toMatchObject({ sheriff_enabled: true, max_days: 7, discussion_rounds: 3 });
    expect(() => resolveGameRules(cfg.rules, cfg.compositions.get('classic-7')!, { discussion_rounds: 99 } as any)).toThrow(
      /discussion_rounds/,
    );
  });
});

describe('loadConfig error reporting', () => {
  it('reports schema errors with file and JSON path', () => {
    const dir = copyConfig();
    editJson(dir, 'models.json', (j) => {
      j.profiles[0].maxOutputTokens = 5;
      j.profiles[1].temprature = 1;
    });
    const issues = issuesOf(dir);
    expect(issues).toContainEqual(expect.objectContaining({ file: 'models.json', path: 'profiles.0.maxOutputTokens' }));
    expect(issues.some((i) => i.file === 'models.json' && /temprature/.test(i.message + i.path))).toBe(true);
  });

  it('reports invalid JSON and missing files', () => {
    const dir = copyConfig();
    writeFileSync(join(dir, 'app.json'), '{ nope');
    rmSync(join(dir, 'names.json'));
    const issues = issuesOf(dir);
    expect(issues).toContainEqual(expect.objectContaining({ file: 'app.json', message: expect.stringMatching(/invalid JSON/) }));
    expect(issues).toContainEqual(expect.objectContaining({ file: 'names.json', message: 'file is missing' }));
  });

  it('checks cross-file references', () => {
    const dir = copyConfig();
    editJson(dir, 'rosters.json', (j) => j.rosters['budget'].push('no-such-model'));
    editJson(dir, 'app.json', (j) => (j.defaultFallbackAlias = 'ghost'));
    editJson(dir, 'models.json', (j) => j.profiles.push({ ...j.profiles[0] }));
    const issues = issuesOf(dir);
    expect(issues).toContainEqual(expect.objectContaining({ file: 'rosters.json', message: expect.stringMatching(/no-such-model/) }));
    expect(issues).toContainEqual(expect.objectContaining({ file: 'app.json', path: 'defaultFallbackAlias' }));
    expect(issues).toContainEqual(expect.objectContaining({ file: 'models.json', message: expect.stringMatching(/duplicate alias/) }));
  });

  it('validates compositions against §12.1 and their file names', () => {
    const dir = copyConfig();
    editJson(dir, 'compositions/classic-6.json', (j) => (j.cards = ['seer', 'witch', 'villager', 'villager', 'villager', 'villager']));
    editJson(dir, 'compositions/classic-7.json', (j) => (j.id = 'other'));
    const issues = issuesOf(dir);
    expect(issues).toContainEqual(expect.objectContaining({ file: 'compositions/classic-6.json', message: expect.stringMatching(/wolf-nature/) }));
    expect(issues).toContainEqual(expect.objectContaining({ file: 'compositions/classic-7.json', path: 'id' }));
  });

  it('applies composition rule overrides before validating (Bear Tamer needs full reveal)', () => {
    const dir = copyConfig();
    editJson(dir, 'compositions/chaos-10.json', (j) => (j.ruleOverrides = { reveal_on_death: 'team' }));
    expect(issuesOf(dir)).toContainEqual(
      expect.objectContaining({ file: 'compositions/chaos-10.json', message: expect.stringMatching(/Bear Tamer/) }),
    );
  });

  it('warns about disabled models used in rosters', () => {
    const dir = copyConfig();
    editJson(dir, 'models.json', (j) => (j.profiles.find((p: any) => p.alias === 'mimo-flash').enabled = false));
    const cfg = loadConfig(dir);
    expect(cfg.warnings.join()).toMatch(/disabled model "mimo-flash"/);
  });
});

describe('BOM handling', () => {
  it('accepts config files saved with a UTF-8 BOM', () => {
    const dir = copyConfig();
    const f = join(dir, 'app.json');
    writeFileSync(f, '\uFEFF' + readFileSync(f, 'utf8'));
    expect(() => loadConfig(dir)).not.toThrow();
  });
});

describe('secrets', () => {
  it('parses .env files', () => {
    expect(
      parseDotEnv('\uFEFF# c\nA=1\nB = "two words"\nC=\'x # not a comment\'\nexport D=4\nE=five # comment\nbad line\n1X=no\n'),
    ).toEqual({ A: '1', B: 'two words', C: 'x # not a comment', D: '4', E: 'five' });
    expect(parseDotEnv('A="abc\nB=\'x')).toEqual({ A: 'abc', B: 'x' });
    expect(parseDotEnv('K=\'abc\' # don\'t\nL="x" # say "hi"')).toEqual({ K: 'abc', L: 'x' });
  });

  it('prefers real environment variables over .env, treating empty values as unset', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ww-env-'));
    temps.push(dir);
    writeFileSync(join(dir, '.env'), 'OPENROUTER_API_KEY=from-file\nHOST_TOKEN=\n');
    expect(loadSecrets(dir, {})).toEqual({ openrouterApiKey: 'from-file', hostToken: null });
    expect(loadSecrets(dir, { OPENROUTER_API_KEY: 'from-env' }).openrouterApiKey).toBe('from-env');
    expect(loadSecrets(dir, { OPENROUTER_API_KEY: '' }).openrouterApiKey).toBe('from-file');
  });

  it('warns about missing or short secrets', () => {
    expect(secretWarnings({ openrouterApiKey: null, hostToken: null }).join()).toMatch(/HOST_TOKEN is not set.*OPENROUTER_API_KEY/s);
    expect(secretWarnings({ openrouterApiKey: 'k', hostToken: 'short' }).join()).toMatch(/shorter than 24/);
    expect(secretWarnings({ openrouterApiKey: 'k', hostToken: 'x'.repeat(32) })).toEqual([]);
  });
});
