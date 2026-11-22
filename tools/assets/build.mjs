#!/usr/bin/env node
/**
 * Psi Wars art pipeline, step 2: masters -> browser derivatives + manifest.
 *
 *   npm run assets:build            (incremental: skips assets whose master hash is unchanged)
 *   npm run assets:build -- --force
 *
 * Input:  art/masters/cards/<ID>.jpg, art/masters/ui/*.jpg   (from extract_psd.py)
 * Output: art/generated/
 *           cards/<ID>-{sm,md,lg}.{webp,jpg}   256 / 512 / 1024 px wide, 788:1088 aspect
 *           backs/{battle,resource}-{sm,md,lg}.{webp,jpg}
 *           ui/logo-{sm,md}.{webp,jpg}, ui/menu-bg-1920.{webp,jpg}
 *           assets.manifest.json               dimensions, hashes, placeholders
 *
 * Card backs were not supplied, so they are generated here as SVG (blue Battle
 * Deck back, gold Resource Deck back, per spec §A2) with the supplied logo inset.
 * Drop real backs into art/masters/backs/{battle,resource}.jpg and they win.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MASTERS = join(REPO, 'art', 'masters');
const OUT = join(REPO, 'art', 'generated');
const MANIFEST = join(OUT, 'assets.manifest.json');
const FORCE = process.argv.includes('--force');

const CARD_W = 788;
const CARD_H = 1088;
const CARD_SIZES = { sm: 256, md: 512, lg: 1024 };
const BG_FRAME = { r: 8, g: 10, b: 18 }; // letterbox colour for off-ratio art

const prev = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, 'utf8')) : { assets: {} };
const manifest = {
  version: 1,
  generatedAt: new Date().toISOString(),
  cardAspect: CARD_W / CARD_H,
  basePath: 'art/generated/',
  assets: {},
};

const hashOf = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 12);
const ensureDir = (p) => mkdirSync(dirname(p), { recursive: true });

async function writeVariants(key, input, sizes, { aspect } = {}) {
  const buf = Buffer.isBuffer(input) ? input : readFileSync(input);
  const hash = hashOf(buf);
  const meta = await sharp(buf).metadata();
  const old = prev.assets?.[key];
  const variants = {};
  const allExist = old && Object.values(old.variants ?? {}).every((v) => existsSync(join(OUT, v.webp)) && existsSync(join(OUT, v.jpg)));
  if (!FORCE && old && old.hash === hash && allExist) {
    manifest.assets[key] = old;
    return false;
  }
  for (const [name, width] of Object.entries(sizes)) {
    const w = Math.min(width, Math.max(width, 1)); // always emit requested width (stand-ins may upscale)
    const h = aspect ? Math.round(w / aspect) : Math.round((w * meta.height) / meta.width);
    let pipeline = sharp(buf);
    if (aspect) {
      // Never stretch: contain inside the card frame, letterboxed in dark.
      pipeline = pipeline.resize(w, h, { fit: 'contain', background: BG_FRAME, kernel: 'lanczos3' });
    } else {
      pipeline = pipeline.resize(w, h, { kernel: 'lanczos3' });
    }
    const base = `${key}-${name}`;
    const webp = `${base}.webp`;
    const jpg = `${base}.jpg`;
    ensureDir(join(OUT, webp));
    await pipeline.clone().webp({ quality: name === 'sm' ? 82 : 86, effort: 5 }).toFile(join(OUT, webp));
    await pipeline.clone().jpeg({ quality: name === 'sm' ? 82 : 86, mozjpeg: true }).toFile(join(OUT, jpg));
    variants[name] = { w, h, webp, jpg };
  }
  const placeholder = await sharp(buf).resize(16).blur(1.2).webp({ quality: 40 }).toBuffer();
  manifest.assets[key] = {
    hash,
    width: meta.width,
    height: meta.height,
    variants,
    placeholder: `data:image/webp;base64,${placeholder.toString('base64')}`,
  };
  return true;
}

function backSvg(kind, logoDataUri) {
  const blue = kind === 'battle';
  const c1 = blue ? '#0b1f4d' : '#4a2f06';
  const c2 = blue ? '#1c4fb8' : '#c58a1c';
  const c3 = blue ? '#5fb4ff' : '#ffd36b';
  const label = blue ? 'BATTLE DECK' : 'RESOURCE DECK';
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${CARD_W * 2}" height="${CARD_H * 2}" viewBox="0 0 ${CARD_W} ${CARD_H}">
  <defs>
    <radialGradient id="bg" cx="50%" cy="45%" r="75%">
      <stop offset="0" stop-color="${c2}"/><stop offset="0.6" stop-color="${c1}"/><stop offset="1" stop-color="#05070d"/>
    </radialGradient>
    <pattern id="hex" width="34" height="58.9" patternUnits="userSpaceOnUse" patternTransform="scale(0.9)">
      <path d="M17 0 L34 9.8 L34 29.4 L17 39.3 L0 29.4 L0 9.8 Z M17 39.3 L17 58.9 M0 29.4 L-17 39.3 M34 29.4 L51 39.3" fill="none" stroke="${c3}" stroke-opacity="0.14" stroke-width="1.4"/>
    </pattern>
    <clipPath id="hexclip"><path d="M394 300 L560 396 L560 588 L394 684 L228 588 L228 396 Z"/></clipPath>
    <linearGradient id="rim" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#e8eef8"/><stop offset="0.5" stop-color="#7b8796"/><stop offset="1" stop-color="#dfe6f0"/>
    </linearGradient>
  </defs>
  <rect width="${CARD_W}" height="${CARD_H}" rx="36" fill="url(#bg)"/>
  <rect width="${CARD_W}" height="${CARD_H}" rx="36" fill="url(#hex)"/>
  <rect x="22" y="22" width="${CARD_W - 44}" height="${CARD_H - 44}" rx="26" fill="none" stroke="url(#rim)" stroke-width="8"/>
  <rect x="40" y="40" width="${CARD_W - 80}" height="${CARD_H - 80}" rx="18" fill="none" stroke="${c3}" stroke-opacity="0.55" stroke-width="2"/>
  <path d="M394 282 L576 387 L576 597 L394 702 L212 597 L212 387 Z" fill="#05070d" stroke="url(#rim)" stroke-width="10"/>
  <image xlink:href="${logoDataUri}" x="214" y="302" width="360" height="380" preserveAspectRatio="xMidYMid slice" clip-path="url(#hexclip)"/>
  <text x="394" y="200" text-anchor="middle" font-family="Arial Black, Arial, sans-serif" font-weight="900" font-size="92" letter-spacing="6" fill="#f2f6ff" stroke="${c1}" stroke-width="3">PSI WARS</text>
  <text x="394" y="860" text-anchor="middle" font-family="Arial, sans-serif" font-weight="700" font-size="44" letter-spacing="10" fill="${c3}">${label}</text>
  <path d="M150 900 H638" stroke="${c3}" stroke-opacity="0.6" stroke-width="3"/>
</svg>`;
}

async function main() {
  let built = 0;
  const cardDir = join(MASTERS, 'cards');
  const cards = existsSync(cardDir) ? readdirSync(cardDir).filter((f) => f.endsWith('.jpg')) : [];
  for (const f of cards) {
    const id = f.replace(/\.jpg$/, '');
    if (await writeVariants(`cards/${id}`, join(cardDir, f), CARD_SIZES, { aspect: CARD_W / CARD_H })) built++;
  }

  const logoPath = join(MASTERS, 'ui', 'logo.jpg');
  const logoBuf = existsSync(logoPath) ? readFileSync(logoPath) : null;
  for (const kind of ['battle', 'resource']) {
    const supplied = join(MASTERS, 'backs', `${kind}.jpg`);
    let input;
    if (existsSync(supplied)) {
      input = readFileSync(supplied);
    } else {
      const logoUri = logoBuf ? `data:image/jpeg;base64,${logoBuf.toString('base64')}` : '';
      input = await sharp(Buffer.from(backSvg(kind, logoUri))).jpeg({ quality: 92 }).toBuffer();
    }
    if (await writeVariants(`backs/${kind}`, input, CARD_SIZES, { aspect: CARD_W / CARD_H })) built++;
    manifest.assets[`backs/${kind}`].generated = !existsSync(supplied);
  }

  if (logoBuf && (await writeVariants('ui/logo', logoBuf, { sm: 256, md: 512 }))) built++;
  const splash = join(MASTERS, 'ui', 'splash.jpg');
  if (existsSync(splash)) {
    // The real splash is 4500x6000 and must never ship at full size: emit a 1920-wide
    // background plus a blurred low-res placeholder only.
    if (await writeVariants('ui/menu-bg', splash, { '1920': 1920 })) built++;
    manifest.assets['ui/menu-bg'].standIn = (await sharp(splash).metadata()).width < 1920;
  }

  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));
  console.log(`assets: ${Object.keys(manifest.assets).length} in manifest, ${built} (re)built -> ${MANIFEST}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
