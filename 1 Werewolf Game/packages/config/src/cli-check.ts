/**
 * `npm run config:check` — validate every config file and print a summary.
 * Exit code 1 when the configuration is invalid.
 */
import { resolve } from 'node:path';
import { validateComposition } from '@ww/shared';
import { ConfigError, loadConfig, resolveGameRules } from './loader';
import { describeSecret, loadSecrets, secretWarnings } from './env';

const root = resolve(process.argv[2] ?? '.');
try {
  const cfg = loadConfig(resolve(root, 'config'));
  const secrets = loadSecrets(root);
  console.log(`Config OK (${cfg.dir})`);
  console.log(`  models:        ${cfg.profiles.length} profiles, ${cfg.profiles.filter((p) => p.enabled).length} enabled`);
  for (const p of cfg.profiles) console.log(`    ${p.enabled ? '✓' : '·'} ${p.alias.padEnd(16)} ${p.openrouterId}`);
  console.log(`  rosters:       ${Object.keys(cfg.rosters).join(', ')}`);
  console.log(`  compositions:`);
  for (const c of cfg.compositions.values()) {
    const rep = validateComposition(c, resolveGameRules(cfg.rules, c).reveal_on_death);
    const w = rep.weightRange ? `${rep.weightRange.min}..${rep.weightRange.max}` : String(rep.weight);
    console.log(`    ${c.id.padEnd(10)} ${String(c.seats).padStart(2)} seats  weight ${w.padStart(6)}  ${c.label}`);
  }
  console.log(`  names:         ${cfg.names.length}`);
  console.log(`  OPENROUTER_API_KEY: ${describeSecret(secrets.openrouterApiKey)}`);
  console.log(`  HOST_TOKEN:         ${describeSecret(secrets.hostToken)}`);
  const notes = [...cfg.warnings, ...secretWarnings(secrets)];
  if (cfg.app.bindAddress === '0.0.0.0') {
    notes.push('bindAddress 0.0.0.0 listens on every network interface of this PC (needed for LAN play). Never port-forward it; set a specific LAN IP to restrict it.');
  }
  for (const w of notes) console.log(`  warning: ${w}`);
} catch (e) {
  if (e instanceof ConfigError) {
    console.error(e.message);
    process.exit(1);
  }
  throw e;
}
