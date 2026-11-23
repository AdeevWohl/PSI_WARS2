// Copies art/generated (derivatives + manifest) into the client's public/art so Vite serves
// and bundles it at /art/. Masters (full-size) are never shipped to the browser.
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, '..', '..', '..', 'art', 'generated');
const dest = resolve(here, '..', 'public', 'art');
if (!existsSync(join(src, 'assets.manifest.json'))) {
  console.error('art/generated is missing — run `npm run assets:build` at the repo root first.');
  process.exit(1);
}
rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });
console.log(`assets synced -> ${dest}`);
