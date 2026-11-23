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
