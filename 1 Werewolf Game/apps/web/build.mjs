import { build } from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Bundle the browser client (ARCHITECTURE.md §12.1: client-sdk and the pure projector only). */
const here = dirname(fileURLToPath(import.meta.url));
mkdirSync(join(here, 'dist'), { recursive: true });

await build({
  entryPoints: [join(here, 'src/main.ts')],
  bundle: true,
  format: 'esm',
  target: ['es2022'],
  outfile: join(here, 'dist/app.js'),
  sourcemap: true,
  minify: !process.argv.includes('--no-minify'),
  logLevel: 'info',
});

// the page shell and the stylesheet are served from the same directory as the bundle
cpSync(join(here, 'public'), join(here, 'dist'), { recursive: true });
console.log('copied public/ into dist/');
