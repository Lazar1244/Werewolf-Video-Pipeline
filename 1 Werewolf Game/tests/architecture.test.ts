import { builtinModules } from 'node:module';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Enforces the package dependency rule of ARCHITECTURE.md §3 (acyclic, downward only)
 * and browser safety for packages that also run in the web UI.
 */
const ALLOWED: Record<string, string[]> = {
  '@ww/shared': [],
  '@ww/engine': ['@ww/shared'],
  '@ww/config': ['@ww/shared'],
  '@ww/store': ['@ww/shared'],
  '@ww/projector': ['@ww/shared', '@ww/engine'],
  '@ww/context': ['@ww/shared', '@ww/engine', '@ww/projector', '@ww/config'],
  '@ww/llm': ['@ww/shared', '@ww/config'],
  '@ww/controllers': ['@ww/shared', '@ww/engine', '@ww/context', '@ww/llm'],
  '@ww/server': ['@ww/shared', '@ww/engine', '@ww/projector', '@ww/context', '@ww/llm', '@ww/controllers', '@ww/store', '@ww/config', '@ww/client-sdk'],
  '@ww/client-sdk': ['@ww/shared', '@ww/projector'],
  '@ww/web': ['@ww/shared', '@ww/projector', '@ww/client-sdk'],
  '@ww/cli': ['@ww/shared', '@ww/engine', '@ww/config', '@ww/store', '@ww/server', '@ww/llm', '@ww/controllers', '@ww/context', '@ww/projector'],
};
/** Packages that must stay browser-safe (no Node built-ins, no Node globals). */
const BROWSER_SAFE = new Set(['@ww/shared', '@ww/engine', '@ww/projector', '@ww/client-sdk', '@ww/web']);

const NODE_BUILTINS = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));

/** Every module specifier in a source file: static, side-effect, re-export, dynamic import and require. */
export function importSpecifiers(src: string): string[] {
  const out: string[] = [];
  const res = [
    /\bimport\s+(?:type\s+)?[\w*${}\s,]*?\s*from\s*['"]([^'"]+)['"]/g,
    /\bexport\s+(?:type\s+)?[\w*${}\s,]*?\s*from\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const re of res) for (const m of src.matchAll(re)) out.push(m[1]!);
  return out;
}

export interface Violation {
  file: string;
  message: string;
}

/** Check one package's source files against the rules. Exported for self-tests. */
export function checkPackage(
  pkgName: string,
  pkgDir: string,
  declaredDeps: string[],
  files: { path: string; src: string }[],
  /** The subpaths each `@ww/` package publishes in its own `exports` map, e.g. `@ww/shared/roles`. */
  publicSubpaths: Record<string, string[]> = {},
): Violation[] {
  const v: Violation[] = [];
  const allowed = ALLOWED[pkgName];
  if (!allowed) return [{ file: pkgDir, message: `${pkgName} is not listed in the dependency rule` }];
  for (const d of declaredDeps.filter((d) => d.startsWith('@ww/'))) {
    if (!allowed.includes(d)) v.push({ file: 'package.json', message: `declares forbidden dependency ${d}` });
  }
  const browserSafe = BROWSER_SAFE.has(pkgName);
  for (const { path, src } of files) {
    for (const spec of importSpecifiers(src)) {
      if (spec.startsWith('@ww/')) {
        const base = spec.split('/').slice(0, 2).join('/');
        // a subpath the package publishes is a public entry point; anything else reaches inside it
        if (spec !== base && !(publicSubpaths[base] ?? []).includes(spec)) v.push({ file: path, message: `deep import "${spec}" (import "${base}" instead)` });
        if (base !== pkgName && !declaredDeps.includes(base)) v.push({ file: path, message: `imports undeclared "${base}"` });
        if (base !== pkgName && !allowed.includes(base)) v.push({ file: path, message: `imports forbidden "${base}"` });
      } else if (spec.startsWith('.')) {
        const target = resolve(dirname(path), spec);
        const rel = relative(pkgDir, target);
        if (rel.startsWith('..') || rel.split(sep)[0] === '..') v.push({ file: path, message: `relative import "${spec}" leaves the package` });
      } else if (NODE_BUILTINS.has(spec)) {
        if (browserSafe) v.push({ file: path, message: `browser-safe package imports Node built-in "${spec}"` });
      } else {
        const parts = spec.split('/');
        const base = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
        if (!declaredDeps.includes(base)) v.push({ file: path, message: `imports undeclared third-party package "${base}"` });
      }
    }
    if (browserSafe) {
      const code = src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
      if (/\bprocess\s*\.|\bBuffer\b|\b__dirname\b|\brequire\s*\(/.test(code)) {
        v.push({ file: path, message: 'browser-safe package uses a Node global (process/Buffer/__dirname/require)' });
      }
    }
  }
  return v;
}

const ROOT = join(import.meta.dirname, '..');

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? tsFiles(p) : p.endsWith('.ts') ? [p] : [];
  });
}

const PACKAGE_DIRS = ['packages', 'apps'].flatMap((base) =>
  readdirSync(join(ROOT, base)).map((d) => join(ROOT, base, d)),
);

/** What each `@ww/` package publishes besides its main entry point, read from its own exports map. */
const PUBLIC_SUBPATHS: Record<string, string[]> = Object.fromEntries(
  PACKAGE_DIRS.map((dir) => {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name: string; exports?: Record<string, unknown> };
    return [pkg.name, Object.keys(pkg.exports ?? {}).filter((k) => k !== '.').map((k) => `${pkg.name}/${k.replace(/^\.\//, '')}`)];
  }),
);

describe('package dependency rule (real packages)', () => {
  for (const dir of PACKAGE_DIRS) {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name: string; dependencies?: Record<string, string> };
    it(`${pkg.name} follows the rules`, () => {
      const files = tsFiles(join(dir, 'src')).map((p) => ({ path: p, src: readFileSync(p, 'utf8') }));
      expect(checkPackage(pkg.name, dir, Object.keys(pkg.dependencies ?? {}), files, PUBLIC_SUBPATHS)).toEqual([]);
    });
  }
});

describe('dependency checker self-test', () => {
  const dir = join(ROOT, 'packages', 'engine');
  const file = join(dir, 'src', 'x.ts');
  const run = (src: string, name = '@ww/engine', deps = ['@ww/shared']) =>
    checkPackage(name, dir, deps, [{ path: file, src }]).map((x) => x.message);

  it('accepts clean code', () => {
    expect(run(`import { a } from '@ww/shared';\nimport { b } from './rng';\nexport * from './text';`)).toEqual([]);
  });
  it('allows a subpath the target package publishes, and nothing else', () => {
    const subpaths = { '@ww/shared': ['@ww/shared/roles'] };
    expect(checkPackage('@ww/engine', dir, ['@ww/shared'], [{ path: file, src: `import { ROLES } from '@ww/shared/roles';` }], subpaths)).toEqual([]);
    expect(
      checkPackage('@ww/engine', dir, ['@ww/shared'], [{ path: file, src: `import { ROLES } from '@ww/shared/src/roles';` }], subpaths)
        .map((x) => x.message)
        .join(),
    ).toMatch(/deep import/);
  });
  it('catches deep imports', () => {
    expect(run(`import { a } from '@ww/shared/src/roles';`).join()).toMatch(/deep import/);
  });
  it('catches forbidden and undeclared packages, incl. side-effect, re-export and dynamic imports', () => {
    expect(run(`import '@ww/store';`).join()).toMatch(/forbidden "@ww\/store"/);
    expect(run(`export { x } from '@ww/config';`).join()).toMatch(/forbidden "@ww\/config"/);
    expect(run(`const m = await import('@ww/server');`).join()).toMatch(/forbidden "@ww\/server"/);
  });
  it('catches relative imports that leave the package', () => {
    expect(run(`import { x } from '../../store/src/db';`).join()).toMatch(/leaves the package/);
  });
  it('catches Node built-ins and globals in browser-safe packages', () => {
    expect(run(`import { readFileSync } from 'fs';`).join()).toMatch(/Node built-in "fs"/);
    expect(run(`import { join } from 'node:path';`).join()).toMatch(/Node built-in/);
    expect(run(`const k = process.env.X;`).join()).toMatch(/Node global/);
    expect(run(`// process.env in a comment is fine\nconst y = 1;`)).toEqual([]);
  });
  it('allows Node built-ins in server-side packages', () => {
    expect(run(`import { readFileSync } from 'node:fs';`, '@ww/config', ['@ww/shared'])).toEqual([]);
  });
  it('requires third-party packages to be declared', () => {
    expect(run(`import { z } from 'zod';`).join()).toMatch(/undeclared third-party package "zod"/);
    expect(run(`import type { z } from 'zod';`, '@ww/engine', ['@ww/shared', 'zod'])).toEqual([]);
    expect(run(`import x from '@scope/pkg/sub';`).join()).toMatch(/"@scope\/pkg"/);
  });
});

describe('source hygiene', () => {
  /** Non-printing characters must be written as escape sequences, never literally. */
  const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u;
  const allowedControl = new Set(['\n', '\r', '\t']);
  const roots = ['packages', 'apps', 'tests'].map((d) => join(ROOT, d));
  const files = roots.flatMap((r) =>
    readdirSync(r, { recursive: true, encoding: 'utf8' })
      .filter((f) => f.endsWith('.ts') && !f.includes('node_modules'))
      .map((f) => join(r, f)),
  );

  it('finds source files to check', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it('no source file contains literal invisible or control characters', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      [...src].forEach((c, i) => {
        if (!allowedControl.has(c) && INVISIBLE.test(c)) {
          offenders.push(`${relative(ROOT, f)} @${i}: U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
