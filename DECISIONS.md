# Decisions log

Decisions not settled by the build prompt, the Q&A or the spec. Each one is reversible unless marked.

## Stage 0 — data and art

1. **Repo location.** The repo is `psi-wars/` inside the art folder, so the ~9 GB of PSDs and the 5.9 GB zip are never in git. `*.psd` is git-ignored.
2. **Art source is the PSD set, not the spec's JPG names.** The §C6 files were not supplied. The finished PSD faces are used, mapped by `artSource` in `cards.json`. Full table in `ART_MAPPING.md`.
3. **Part B values win over the printed art.** This follows prompt §1: transcribe Part B verbatim, and the Q&A confirms the readings. Where the art differs (Dark Shredder Psionic 1 vs 2; Shadow Assassin 1/X vs X/2), `cards.json` stores the art's numbers in `printed`. The renderer overlays chips wherever the current value differs from `printed`. *Flip:* edit `stats` for those two cards (or set it in the balance file) if the art is the newer intended balance.
4. **Extra art-only cards are data, disabled.** All 17 are transcribed from their faces with `enabled: false`. This covers the prompt's four named extras (§10) and 13 more. Where the art and the rule book disagree on an extra (Acorbeac Cyber 1 vs 3; Xardy Piercer W1 and name), the printed card wins, per spec "card text wins".
5. **"Win" triggers on the extras** (Kyler's "Physical win", Javarow's "Digital win", Nomis's "Cyber win") use the spec's Psionic-win definition: strictly higher total in that battle. Encoded as triggers `OnPhysicalWin` / `OnCyberWin` / `OnPsionicWin`.
6. **Warend Reaper / Bellarn / Xardy side 5** is not mentioned on the card ("3, 4 or Obliterate = +1; 1 or 2 = −1"), so side 5 = no change. It lives in the data table `bySide`.
7. **Grankor escape with Physical X** (only possible for the disabled Pencar Inferno): X counts as 0, because escape uses base + equipment with "X/modifiers not applied".
8. **CU payment is chosen by type, not by individual card.** CUs of one type are interchangeable, so the payment choice (RULING A7-b) is which *types* to destroy for the white cost. The engine then picks concrete cards deterministically.
9. **Card backs and splash are generated stand-ins** until the real files arrive (see `ART_MAPPING.md`). Dropping in the real files needs no code change.
10. **Asset pipeline is two steps.** Python (psd-tools) extracts PSD masters once, because no Node library composites these PSDs correctly (alpha-channel composites, CMYK + ICC). Node (sharp) builds every derivative and the manifest, and is what the team re-runs. Masters (45 MB) and derivatives (32 MB) are committed, so nobody needs Python or the PSDs to build the game.
11. **Node 26 (current LTS from winget)** is the toolchain. `engines` says >= 20.

## Stage 1 — rules engine

12. **Engine shape: an interpreter over a serialisable task stack.** Every pending step (phase, battle stage, effect waiting on a choice) is a plain-data task in `state.tasks`, and every decision is a single `state.prompt`. A game can be snapshotted at any prompt (JSON) and resumed byte-identically. This serves the netcode, Durable Object hibernation, replays and the determinism test.
13. **Commands.** `PlayCard` carries its payment and target, so the spec's separate `ChoosePayment` / `ChooseTarget` / `PlayPower` are folded into one atomic command. That removes half-finished plays from the protocol. Added `Concede` for leaving online games.
14. **Instant windows (house rules K, L, M).** Traps may be played from any priority window and from the declare-attackers/blockers prompts. Windows open at: after any Battle Unit / Equipment is played (for the other players), end of Draw, end of Creation, after attackers are declared, the Battle step 3 Power window (all players, all Power cards), and before Cleanup escapes. Each point can be switched off in `data/rules.json → instantWindows`. Phase-point windows poll the non-active players. Once anything is on the stack, **every** live player is polled, so the target's owner can always respond. A caster keeps priority after playing (§A8 step 3). When everyone passes in succession, the top of the stack resolves (last in, first out).
15. **Timeouts live in the server, not the engine.** The engine never auto-passes on time. The server enforces the ~3 s response window (M) by sending `Pass` on expiry. `config.autoPassNoPlay` skips seats with no legal play. That is the "fast windows" setting, and also J's "skip players who cannot afford any card". It leaks information, so it is off by default online and on for hot-seat/AI play.
16. **Only Power and Trap cards use the stack.** Battle Units and Equipment resolve immediately, then the other players get a response window. Creation Units never get played; the Creation Oracle from hand resolves immediately with no window.
17. **Equipment management timing.** Move and discard are allowed in your own Creation phase and in your declaration step (attacker step 1, defender step 2). Equipment rides along on stack/trap/destroy events; an invariant check guarantees no Equipment ever exists without a unit.
18. **Stacking** is only allowed in the declaration steps (the C7 demo bug allowed it during Creation).
19. **Trap targets are opposing units.** The card text says "Target an opposing Battle Unit". The Q&A's "any unit, any time" is read as relaxing *timing*, not targeting. A trap whose target is no longer legal on resolution fizzles to the discard pile.
20. **Win triggers** (Jingwa, Nomis, Acorbeac, Kyler, Javarow, Third I) fire for the winning side even if that unit is later destroyed in the Physical battle. "Physical win" = strictly higher Physical total, even if a Disoriented winner destroyed nothing. Blade Master deals its 1 damage once per battle won by destruction (a Stack of two counts once).
21. **Lodner's "[Obliterate]"** means side 6 in both dice variants.
22. **A Creation Oracle draw is public**; its default answer is "keep". Trap escape attempts are made automatically (there is no downside to trying).
23. **Disable effects (High-Energy Pulse, Mental Disrupter)** are evaluated live until end of turn. A unit that later gains Cyber (via Equipment) or enters play is also affected.
24. **Hidden-information hygiene.** Card uids are assigned after shuffling, so a uid never reveals identity or deck-list position. Per-seat views never contain another seat's hand or deck uids, and a test checks this after every command in the integration games. Search/tutor choices are visible to the chooser only.
25. **Eliminations (house rule D).** If the active player is eliminated mid-turn, the turn aborts and anything on the stack is discarded. If a player who holds a prompt is eliminated or concedes, the prompt's default answer is applied.
26. **Surviving attackers are replenished** when the Battle phase ends (§A9.1). Stacks split and Disoriented ends at the same moment.
27. **`config.maxTurns`** (default 0 = off) ends a game as a draw. It is a safety valve for AI-vs-AI simulation only.

## Stage 2 — client and hot-seat

28. **No UI framework.** Vanilla TypeScript with a tiny `h()` helper. The board is a keyed renderer: each visible card keeps one DOM element for life and is re-parented as it changes zone. That is exactly what the FLIP animations in Stage 3 need.
29. **A fixed 1920×1080 stage scaled to fit the window** (letterboxed). The layout is identical at every aspect ratio and on tablets, and the Stage 3 UI-scale setting multiplies the fit.
30. **The engine computes, the client displays.** The view now carries each unit's live strengths (`unitStats`, auras included), each playable card carries its auto-pay suggestion, and each unplayable card carries the exact reason ("Needs 1 more Neurogenesis"). The client re-implements no rules.
31. **Hot-seat curtains follow the current decision.** Whenever a decision belongs to a different person at the device, a full-screen curtain hides everything; the board underneath is re-rendered as a spectator, so no hidden card is even in the DOM. Hot-seat uses fast windows (no prompt when you have nothing to play), so a curtain for a Trap window does reveal that the other player *can* respond. On one shared screen that is unavoidable.
32. **Commands are queued, never dropped,** and only one answer per prompt can be queued (double-click guard). This replaced a "busy" flag that silently dropped a fast click; that race would have bitten online play.
33. **Interaction is click-to-select** for everything (play, target, pay, attack, block, stack, move/discard Equipment), plus Space/Enter for the primary action and Esc to cancel. Drag-and-drop lands with the Stage 3 animation system, because it shares the elevation and FLIP machinery.
34. **The final board stays intact at game over.** House rule D's "an eliminated player's cards leave the game" applies only while the game continues.

## Stage 3 — animation, effects, settings

35. **Presentation model.** The board is rendered in its final state, then each card that moved is pinned at its old position with a paused FLIP. The event that moved it releases the pin. Cards that left the board become ghosts. Overlays (dice, banners, damage numbers, particles) play in event order. Skip or Instant finishes everything at once; the engine state was committed first, so outcomes never depend on animation (§6.1). A check after every animated batch (three full games, Fast/Normal/Cinematic, 125 random skips) found the board identical to a clean render each time.
36. **Hidden tabs present instantly.** Browsers may stop advancing animation timelines in background tabs, which would stall the queue.
37. **Auto-degrade ignores throttling.** Frame gaps over 200 ms (an occluded or background window) are discarded, and the decision uses the median frame time over ~1 s. The toast offers Undo.
38. **Danger rim threshold:** a side with at least a 55% chance of being destroyed, using the engine's exact `battleOdds` (no re-rolls; unrolled X counted as 3 for stacks).
39. **Turn timer in local games** applies per decision, and expiry applies the prompt's default answer. Online, the server owns the timer (Stage 5). "Confirm before ending phase" asks only when something is still playable.
40. **Audio.** No assets were supplied. Every hook plays a short synthesized placeholder (switchable). Real files are a data change in `AUDIO_FILES`. The music slider is wired, but there is no music yet.
41. **Victory/defeat** zoom toward the winning Lab, with a burst and a banner; a loss also desaturates the board. The results modal follows.

## Stage 4 — AI

42. **One AI for every host.** `chooseCommand(level, view, legal, rules, rng)` lives in the engine package (pure, no timers), so the browser, both servers and the simulator all run the same AI. It receives the seat's filtered view and legal-action list only, so it cannot see hands or deck order.
43. **Exact odds instead of Monte Carlo.** Battle evaluation enumerates every die outcome (`battleOdds`), memoised by strength signature. Same purpose as the spec's ~200 samples, with no sampling noise, at about 0.2 ms per decision on average.
44. **Attacking is nearly free.** Survivors are replenished at Cleanup and depleted units can block, so Normal starts from "everyone attacks" and drops the attacker the defender punishes worst until the rest have acceptable odds. Hard searches every attack subset (up to 8 attackers) against the defender's one-to-one replies, holds Traps for the opponent's attack, and re-rolls by exact probability.
45. **Measured strength (mirror matches, same deck both sides, 160 games each):** Normal beats Easy 65%, Hard beats Easy 71%, Hard beats Normal 54%. Dice variance caps how lopsided this game can be.
46. **Balance finding for the team:** with the starter decks as listed in spec §B3, **Creature Commander beats Robot Commander 68% (Easy mirror) to 80–84% (Normal/Hard)**. Better play widens the gap. This is exactly what Stage 8's simulator and card editor are for.
47. **Local AI pacing:** a computer seat acts after the animation queue settles, with a 260–650 ms delay scaled by the animation speed (zero at Instant).

## Stage 5 — online play

48. **A shared room core, `packages/room`** (an addition to the §11 layout). The lobby, seats, game, per-seat filtering, sequence numbers, deadlines, AI seats, reconnect grace, host hand-over and rate limiting live in one pure-TypeScript `Room` with no platform APIs. Hosts deliver messages, call `tick()` at `nextDeadline()`, and persist `serialize()`. The Cloudflare Durable Object and the Node server are thin adapters around it, so "test the whole game against both" tests the same code. The same end-to-end WebSocket test passes against both servers (`wrangler dev` for Cloudflare).
49. **Messages.** The join/resync/reconnect snapshot carries the full filtered view (with card definitions). Every later update carries the seat's filtered events plus a patch of its view (changed top-level keys, and changed entries of the `cards`/`unitStats` maps). Tests check that the client view rebuilt from patches equals the server's filtered view after every command, and that average updates are under a quarter of a snapshot.
50. **Deadlines are server state.** Response windows (house rule M, 3 s default), the optional turn timer, and AI move delays are one `pending` deadline. On expiry the server applies the prompt's default (Pass, etc.) or the AI's choice. The client only displays the countdown, converted with a measured server-clock offset.
51. **Reconnect identity is per tab** (`sessionStorage`). It survives reloads but differs between tabs, so two tabs are two players. A reload in the same tab rejoins the seat directly. Lobby seats are released on disconnect; in-game seats are held for 120 s, then the host is offered "computer takes over" (Easy/Normal) or "keep waiting". If the host is the one gone, hosting passes to a connected player.
52. **Rate limit:** token bucket of 60 messages, refilling 25 per second per connection. Excess messages are dropped with a non-fatal `rate` error (so a client never waits silently for an ack), and persistent floods are disconnected. All rejections are logged.
53. **Spectators.** A third person joining a full or running room watches with the public view (no hands, no actions).
54. **Rematch** keeps the room and seats: the host starts again from the results screen.
55. **Storage.** The persisted room drops card definitions and rules (re-injected on restore) to stay small (<200 KB). Rooms survive Durable Object eviction and hibernation; a test restores a serialised room mid-game and continues identically.
56. **Wrangler 4** (v3 reported itself out of date). `run_worker_first` routes `/api` and `/ws` to the Worker, and everything else to Workers Assets on the same origin.
57. **Not verified here:** a real deployment (needs your Cloudflare account) and a Quick Tunnel (needs `cloudflared`, not installed on this machine). Both are documented step by step in the README. Everything else was exercised: both servers locally, two browser tabs through the Cloudflare runtime (host, join by invite link, full game, mid-game reload back into the seat, rematch).

## Stage 6 — 3–4 players

58. **One local setup for every mix.** "Play vs AI" and "Hot-seat" are two presets of the same screen: 2–4 seats, each a person at this device or a computer (Easy/Normal/Hard). Curtains appear whenever play passes between two people at the device, and computer seats act on their own.
59. **Opponents share the top row** in compact areas sized by count (card width 104 / 90 / 74 px for 1 / 2 / 3 opponents). Their units overlap like a fan and open up when the area is hovered or focused (keyboard-focusable). Creation Units collapse to small chips.
60. **Per-attacker targeting (house rule A).** In the declare step the prompt shows one chip per opponent in that player's colour. Picked attackers go at the selected opponent, carry a "→ name" tag and an outline in the target's colour, and clicking one again re-targets or un-picks it. Dragging a unit onto an opponent's area targets that opponent. Battlefield columns are tinted and labelled "attacker → defender".
61. **Turn order is always visible** in the side panel: every seat in play order with HP, the active player marked, eliminated players struck through, offline players flagged.
62. **Seat names are unique** (local and online) — e.g. "Computer (Normal) 1" and "2" — so the board, turn order and log are never ambiguous.
63. **Online computer pacing is configurable** (`aiDelayScale`; 1 = paced for humans, 0 for tests). A 4-seat online game (two people, two computers) completes end to end.
