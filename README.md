# Psi Wars

Browser card game: a pure TypeScript rules engine, an art-driven client, AI opponents, and online play with room codes (2–4 players).

> **Status: Stage 5 of 9 complete.** Rules engine, art-driven client with animation and settings, Play vs AI (Easy / Normal / Hard), hot-seat, and **online play**: host a room, share its code or invite link, friends join from any network. 3–4 player layouts (Stage 6), the deck builder and tutorial (Stage 7) and the balance tools (Stage 8) come next.

## Requirements

- **Node.js 20 or newer.** Check with `node --version`. Get it from nodejs.org if needed.
- Run every command below in a terminal opened in this `psi-wars` folder.
- Python 3 with `psd-tools` is needed **only** to re-extract art from the artist's PSDs. The extracted art is already included.

First time only:

```powershell
npm install
```

## Play on this computer (vs AI or hot-seat)

```powershell
npm run dev
```

Open http://localhost:5173 and choose **Play vs AI** or **Hot-seat**.

## Play online with friends — the quick way (no account)

One player runs the game server on their computer and shares it through a free Cloudflare **Quick Tunnel**. Nobody needs to touch a router or forward ports.

1. Start the server. It builds the game and then serves it on port 8787:

   ```powershell
   npm run serve
   ```

2. In a **second** terminal, install `cloudflared` once (the official Cloudflare tool) and open a tunnel:

   ```powershell
   winget install --id Cloudflare.cloudflared
   ```

   ```powershell
   cloudflared tunnel --url http://localhost:8787
   ```

3. `cloudflared` prints an address like `https://something-random.trycloudflare.com`. Everyone (the host too) opens that address, then:
   - The host clicks **Host Game**, gets a 6-letter room code and clicks **Copy invite link**.
   - Friends open the invite link, or click **Join Game** and type the code.
   - The host fills empty seats with computer players if wanted and clicks **Start game**.

Good to know about Quick Tunnels:

- The address is random and **changes every time** you start the tunnel. Share the new one each game night.
- The game **ends for everyone** the moment the server or the tunnel window is closed.
- There is no uptime guarantee. It's fine for a game night, not for a permanent service.
- Each tunnel handles up to 200 requests in flight, far more than a 4-player game needs.
- Quick Tunnels don't support Server-Sent Events. That doesn't matter here, because the game uses WebSockets.

## Put it on the internet with Cloudflare (permanent address, free plan)

This deploys the game and its server to Cloudflare Workers with Durable Objects. That runs on the **free** plan and gives you a permanent address to share.

1. Create a free account at https://dash.cloudflare.com/sign-up. No payment details are needed for the free plan.
2. In this folder, log in. A browser window opens and asks you to allow access:

   ```powershell
   npx wrangler login
   ```

3. Deploy. This builds the game and uploads it with the server:

   ```powershell
   npm run deploy
   ```

4. Wrangler prints your address, for example `https://psi-wars.<your-name>.workers.dev`. Share that address. Hosting and joining work exactly as above.

Run the same command again to publish an update. Each room is one Durable Object; idle rooms close after 2 hours. To try the Cloudflare server on your own computer first, run `npm run cf:dev` and open http://localhost:8787.

## How online play works

- **Server-authoritative.** The server holds the one true game, rolls all dice and shuffles all decks. Players send commands; the server checks every one against the rules for that seat and rejects anything else (rejections are logged). Each player receives only what their seat may know. Opponents' hands and deck order never leave the server, so they can't be read from the network tab.
- **Room codes.** Codes are 6 characters with no `0/O` or `1/I/L`. The invite link pre-fills the code.
- **Reconnect.** If a player's connection drops, the game reconnects automatically. Reloading the page puts them straight back in their seat. Seats are held for 2 minutes; after that the host can hand the seat to the computer or keep waiting.
- **Response windows.** When a Trap could be played, every player gets the same short window (3 s by default), so a pause never reveals who holds one. "Fast windows" skips players with nothing to play. It's quicker, but leaks that information.
- **Same protocol everywhere.** Both servers (`packages/server` on Cloudflare, `packages/server-local` on Node) run the identical room code from `packages/room`. A protocol version check refuses mismatched clients with a plain message.

## Tests

```powershell
npm test
```

The default run plays 200 random games in the fuzz test. For the long run:

```powershell
$env:FUZZ_GAMES=3000; npx vitest run packages/engine/test/fuzz.test.ts -t fuzz
```

To run the online end-to-end tests against the Cloudflare server too, start `npm run cf:dev` in one terminal, then:

```powershell
$env:PSI_BASE="http://localhost:8787"; npm run test:cloudflare
```

## Art pipeline

```powershell
npm run assets:build
```

This regenerates `art/generated/` (WebP + JPEG at 256/512/1024 px, card backs, menu background, `assets.manifest.json`) from `art/masters/`. It is incremental; add `-- --force` to rebuild everything. To re-extract masters when the artist sends new PSDs:

```powershell
pip install psd-tools pillow
```

```powershell
python tools/assets/extract_psd.py --psd-dir "../Final Cards Single Number Full Art" --loose-dir ".."
```

## Layout

```
packages/
  shared/        commands, events, wire protocol, room codes
  engine/        pure TS rules engine + AI (no DOM, network or timers)
  room/          the authoritative game room, shared by both servers
  client/        Vite + TS client (render/, anim/, ui/, game/, net/)
  server/        Cloudflare Worker + Durable Object (wrangler.toml)
  server-local/  Node WebSocket server (same protocol), for tunnels and development
data/            cards.json, rules.json, rulings.json, decks/, balance/
art/             masters/ (extracted) and generated/ (browser derivatives)
tools/           assets/ (art pipeline), data/ (data tests), dev/ (AI stats), sim/ (Stage 8)
```

## Engine in one paragraph

`createGame(setup)` returns a state paused at the first prompt. `getLegalActions(state, seat)` lists everything that seat may do. `applyCommand(state, seat, command)` validates the command, returns a **new** state plus the events it caused, and never mutates its input. `viewFor(state, seat)` and `filterEvents(events, seat)` produce what one seat is allowed to see. Dice and shuffles come from a seeded RNG stored in the state, so the same seed and the same commands always give the same events. `chooseCommand(level, view, legal, ...)` is the AI.

See `ART_MAPPING.md` for the art inventory and `DECISIONS.md` for judgement calls.
