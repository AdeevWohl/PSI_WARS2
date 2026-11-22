# Psi Wars

Browser card game: a pure TypeScript rules engine, an art-driven client, AI opponents, and online play with room codes (2–4 players).

> **Status: Stage 0 of 9 complete.** Data, art pipeline and toolchain are in place. The rules engine (Stage 1) comes next. The run, tunnel and deploy sections below will be filled in as those stages land.

## Requirements

- Node.js 20 or newer (`node --version`)
- Python 3 with `psd-tools` **only** to re-extract art from the artist's PSDs. Extracted art is already committed, so most people never need this.

## Commands

```powershell
npm install
```

```powershell
npm test
```

```powershell
npm run assets:build
```

`npm run assets:build` regenerates `art/generated/` (WebP + JPEG at 256/512/1024 px, card backs, menu background, `assets.manifest.json`) from `art/masters/`. It is incremental, and `-- --force` rebuilds everything.

Re-extracting masters from the PSDs (only when the artist sends new files):

```powershell
pip install psd-tools pillow
```

```powershell
python tools/assets/extract_psd.py --psd-dir "../Final Cards Single Number Full Art" --loose-dir ".."
```

## Layout

```
packages/
  engine/        pure TS rules engine (no DOM, network or timers)   — Stage 1
  shared/        command & event schemas, protocol version           — Stage 1
  client/        Vite + TS client                                    — Stage 2+
  server/        Cloudflare Worker + Durable Object                  — Stage 5
  server-local/  Node WebSocket server, same protocol                — Stage 5
data/
  cards.json     every card: Part B verbatim + 17 art-only extras (disabled)
  rules.json     dice faces, deck limits, house-rule constants, instant windows
  decks/         starter decks (Creature Commander, Robot Commander)
  balance/       balance overrides layered over cards.json (Stage 8)
art/
  masters/       full-resolution sRGB masters extracted from the PSDs
  generated/     browser derivatives + assets.manifest.json
tools/
  assets/        art pipeline (extract_psd.py, build.mjs)
  data/          data validation tests
  sim/           AI-vs-AI batch simulator (Stage 8)
```

See `ART_MAPPING.md` for the art inventory and `DECISIONS.md` for judgement calls.
