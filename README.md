# Psi Wars

Browser card game: a pure TypeScript rules engine, an art-driven client, AI opponents, and online play with room codes (2–4 players).

> **Status: Stage 1 of 9 complete.** The full rules engine runs headless with 149 tests (every §12 case, every card ability, 3–4 player rules, determinism, fuzz). The client (Stage 2) comes next. The run, tunnel and deploy sections will be filled in as those stages land.

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

The default fuzz run plays 200 random games. For the long run:

```powershell
$env:FUZZ_GAMES=3000; npx vitest run packages/engine/test/fuzz.test.ts -t fuzz
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
  engine/        pure TS rules engine (no DOM, network or timers)   — done
  shared/        command & event types, protocol version             — done
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

## Engine in one paragraph

`createGame(setup)` returns a state paused at the first prompt. `getLegalActions(state, seat)` lists everything that seat may do. `applyCommand(state, seat, command)` validates the command, returns a **new** state plus the events it caused, and never mutates its input. `viewFor(state, seat)` and `filterEvents(events, seat)` produce what one seat is allowed to see. Dice and shuffles come from a seeded RNG stored in the state, so the same seed and the same commands always give the same events.

See `ART_MAPPING.md` for the art inventory and `DECISIONS.md` for judgement calls.
