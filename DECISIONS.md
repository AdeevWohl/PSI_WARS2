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
