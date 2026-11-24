# v0.4 card set: migration plan and rule interpretations

Source of truth: the v0.4 implementation prompt, then the workbook's **Cards** and **Rules and Keywords** sheets, then the existing game. Baseline checkpoint: git tag `v0.3-baseline`.

## What already existed (reused)
- Task-stack engine with prompts, seeded RNG, LIFO stack of Power cards with response windows.
- Payment enumerator that already tries every combination (no greedy failure) for fixed colours, "pay any" (A), one-of lights (`choice`) and destroy (W).
- Permanent modifiers (`permMods`), damage model (damage reduces Physical until end of turn, lethal at ≥ current Physical), zero-strength Disorientation, Stacking, containment zone (`trapped`).

## New systems
| System | Where | Notes |
|---|---|---|
| Independent burn pool | `Cost.burnPool` (payment.ts) | Empty pool = legacy rule (card's colours, else any). `Any` = all four types. |
| Resource Fortification one-use | payment.ts | When it turns a burn into a depletion, the Fortification is discarded. |
| Power timing | `CardDef.timing: 'Pulse' \| 'Operation'` (plays.ts) | Operations only from your own Creation prompt (stack is always empty there). Pulses in every priority window and declaration prompt. "Trap" card type retired; Grankor is a Pulse. |
| Modifier log | `CardInstance.modLog` (mods.ts) | Every stat change is logged with kind (`temp`, `permanent`, `mutation`, `reanimated`, `stack`, `battle`), shown in the card tooltip. |
| Stack-duration mods | `CardInstance.stackMods` | Count only while the unit is stacked; cleared when a new Stack forms and at end of turn (Stacks separate at end of Battle phase anyway). |
| Ability rolls | `abilityRoll` task (abilities.ts) | X rolls and printed ability rolls. Lock-On hooks in here; rerolls of locked results are refused. |
| Lock-On | abilities.ts | Asked of the opposing controller before each eligible ability roll in a blocked engagement; one activation per Lock-On unit per engagement, one lock per roll. |
| Calibration | battle.ts dice stage | A calibrated die is `side 0` = fixed +2, no icons; it can still be obliterated by an enemy 6 and never obliterates. |
| Protocol | `CardInstance.protocol` | Chosen on creation and offered at the start of each of the owner's Creation phases. Public. |
| Generic decisions | prompt kind `decide` | Token options with labels and public-information scores used by the AI. |
| Activated abilities | command `Activate` | Creation-phase abilities (Fabricator Drone, Scrap Harvester, Suture Architect) and Loquidor Stalker in the Power window. |
| Equipment relocation | `CardDef.equip.moveCost` | Creation phase only; costs paid from ready CUs; no free moves during declarations. |

## Interpretations of unclear wording (smallest consistent reading)
1. **"Each Battle phase" damage shields** (Javarow Protector, Interface Plating): ability damage also happens outside Battle phases, so the shield is "once per turn". 
2. **Neural Interface** has no X of its own: it lets its Stack partner reroll that partner's X roll once.
3. **Kyler Revenant** "when this Stack destroys": read as "this or its Stack", like the other Cyborgs.
4. **Davileam "choose up to two"**: asked one unit at a time (pick or stop).
5. **Duplicate Davileam / Grid Marshal Protocols**: each copy keeps its own mode; the "only one grants a protocol" restriction for duplicate Davileams is enforced by letting Assault/Guard trigger once per Battle phase per controller.
6. **Unstable Carapace / Forced Evolution** rolls are Power rolls: Lock-On cannot touch them.
7. **Molting** is offered while a damage-dealing Power that targets your Creature/Cyborg is on the stack.
8. **Emergency Firewall** counters Pulses whose effect contains, disables or removes from battle (Grankor, Interference Net, Parasitic Snare, High-Energy Pulse, Mental Disrupter) when exactly one of the targets is your Robot/Cyborg.
9. **Total printed cost** (Carrion Foundress, Robo Refurb, Creature Regenerate, Brood Recall, Swarm Caller, Modular Assembly) = G+B+R+P+W+A+number of mixed lights.
10. **Permanent strength comparisons** treat printed X as 1.
11. **Fabricator Drone discount** removes one fixed P, else one mixed light that allows P.
12. **Siana Commander** asks at end of Battle phase; the survivor must have been in a blocked engagement this phase.

See the implementation report at the end of this file for coverage and limitations.

---

# Implementation report (first v0.4 pass)

## Card coverage
All 97 workbook cards are imported with their workbook costs, strengths, Equipment values, timing and relocation costs (no rebalancing). Every card has executable engine effects (tools/data/import_v04.py → packages/engine/src/v04.ts); none is text-only. 43 new cards got stable IDs (data/v04_ids.json); renamed cards keep their old IDs and artwork; new cards use the generated card face until art exists.

Verified by automated tests: mixed costs, burn pools, double-pay prevention, Burn Any, Pulse vs Operation timing, Calibrate, Lock-On (paid, chosen face, not offered without the cost), Chitin Weaver Mutation (survives Cleanup; not from unblocked attacks), Cannibalistic Instinct (permanent buffs counted, temporary ignored), Carrion Foundress feeding. All other cards are exercised by the AI simulations (no errors in 400+ games) but do not yet have dedicated tests.

## Simplifications to review
- **Payment choice** is by CU type (which colours to deplete or burn), not by individual card; fortified CUs are spent on burns first. This only matters in edge cases.
- **Marrow Parasite against a destroyed Stack** takes the better reward automatically instead of asking which member to compare.
- **Swarm Caller** puts the rest on the bottom in their existing order (no reorder prompt).
- **Davileam duplicates**: Assault and Guard trigger once per Battle phase per controller.
- **Equipment Mechanic**: its base cost is paid first and the Equipment's own cost on resolution. If you paid the base cost badly, the card can fizzle.
- **Lock-On with several eligible lockers**: the first eligible unit is offered; you can't pick which.
- **UI**: the new decisions use a generic decision dialog (labelled options). The active Protocol and every strength change are shown as markers with hover text on the unit, and in the log. Multi-target Powers ask for their second target in a card-choice dialog after the first. Calibrated dice (fixed +2) are shown with the existing dice animation, so they may look like a normal roll. Not checked by hand in the browser yet.

## AI
The AI handles every new prompt. Decision options carry public-information scores from the engine: Lock-On faces are scored by their outcome (including Creature riders), plus Calibrate, Protocol modes, Stack bonuses, feeding and Siana choices. It also reserves a Digital Splicing for Lock-On, forms Stacks before attacking, avoids blocking Carrion Foundress with expensive units, respects Stealth Skyfire, uses combat Pulses, reactive Pulses (Firewall, Molting, Repair Circuit), Loquidor intercepts, Fabricator Drone and Scrap Harvester. It does not relocate Equipment voluntarily, and it does not plan lethal Cannibalistic Instinct bursts beyond simple scoring.

## Simulation (400 games, Normal AI, 15 HP, every ordered deck pair ×20 seeds)
See reports/v04-sim.md. Results:
- No errors or turn-limit stalemates.
- First player won 57.3%. Games averaged 11.7 turns (median 10). The first Battle Unit arrived on turn 2.7 on average.
- Win rates: Creature Swarm 71.9%, Robot Industrial 61.9%, Creature Evolution 51.2%, Robot Control 33.8%, Mixed Integration 31.3%.
- Mechanics: Calibrate 105, Protocol choices 359, Mutations 25, feeding triggers 32 (9 creations), Reanimated returns 24, Stacks formed 389 (226 Stack fights: 116 kills, 5 Stacks lost), containments 163, Lock-On 3.
- Resource destruction is low: 0.76 CUs burned per game for costs, none destroyed by effects. Creation phases with no ready CU: 0.1%.

## Potential balance concerns (for design review, not changed)
1. **Lock-On rarely has a target.** Only a few opposing ability rolls happen in blocked fights against Lock-On units, so Robot Control's signature tool is mostly idle and the deck underperforms. Lock-On may need more eligible rolls, or Control more ways to force blocks.
2. **Creature Swarm is strongest**, mostly from cheap 3-Physical bodies and width bonuses. Watch Rupture Brute ×3 plus Trangarey/Hive Regent.
3. **Mixed Integration is weakest** despite heavy Stacking: Stacks almost never die (5 losses in 226 fights) but the deck lacks pressure. This could also be AI play quality.
4. **First-player advantage** (57%) is slightly above the 45–55% target.
5. **Many Powers in the example decks were rarely or never cast by the AI.** This was improved after the 400-game run (Cannibalistic Instinct and Forced Evolution now get played); re-run the simulation to update these numbers.
6. **Burn costs barely tax resources.** CU starvation is near zero.

---

# v0.4.1 — Battle Unit readiness

Implemented exactly as specified (supersedes earlier depletion rules):
- Attacking and defending no longer deplete. The Cleanup re-readying of surviving attackers is removed; readiness changes only through the controller's Replenish phase or effects.
- Attackers and defenders must be ready, including both members of a Stack. Depleted units can't join Stacks. Each unit fights in one engagement per Battle phase (declarations reject a second use; Loquidor Stalker must be ready and unengaged).
- New `depleteUnit` helper (v04.ts): a unit depleted during an unresolved engagement leaves it. Its Stack breaks and the ready partner fights on; an empty defending side makes the attacker unblocked; an empty attacking side cancels the attack. Readying it again doesn't return it to the fight. Used by Parasitic Snare, Fabricator Drone and Emergency Separation.
- Depletion doesn't switch off passive, triggered or aura abilities, Equipment, targeting or Cannibalize. Only combat eligibility checks readiness.
- **Parasitic Snare** (Pulse, unchanged cost): "Choose a Battle Unit under enemy control. Deplete it. It loses 1 Physical until the end of the turn." The text is overridden in the import script because the workbook still has the old text.
- AI: uses Fabricator Drone only when its other ready units cover every ready enemy attacker, or the possible Lab damage is small. Plays Parasitic Snare on an engaged enemy (removing it from its fight) or on a ready blocker before attacking.
- Updated: rulebook (Steps 1–2, Cleanup, the v0.4.1 section), tutorial text, one v0.3 Stacking test (depleted units can no longer stack). New tests: 8 readiness tests plus 2 AI tests.

Simulation after the change (400 games, same setup) — see reports/v04-sim.md:
- First player won 58.5%. Games averaged 11.5 turns. No errors or stalemates.
- Win rates: Swarm 72.5%, Industrial 61.3%, Evolution 53.8%, Control 33.1%, Mixed 29.4%.
- Other counts: Cannibalize 47, Lock-On 4, Stack fights 180 (6 Stacks lost).
- Little change from v0.4, as expected: before, depleted units could already defend, so attacking never cost a unit its block. The new rules mainly make effect-based depletion (Snare, Fabricator) a real combat cost.

---

# v0.4.1 refinement pass (Reactive/Creation, restrictions, shortcuts, AI, telemetry)

Note: the only v0.4.1 message received before this pass was the Battle Unit readiness prompt (implemented above, kept as core rules). The list below follows the later request that summarised the remaining items.

## Status of the requested items
| # | Requirement | Status |
|---|---|---|
| 1 | Rename Pulse/Operation to Reactive/Creation | **Done.** Card data, engine (old names still accepted for older data), UI type lines and keywords, rulebook, rulings, PDF, spreadsheet. Card names such as High-Energy Pulse are unchanged. |
| 2 | Source-specific restrictions instead of trapped/untrapped | **Done for every v0.4 card.** Restrictions block attack, defend, target, activate, passive and cost independently, each with a duration: end of turn, the owner's next Cleanup, or until an escape roll succeeds. Used by Grankor, Interference Net, High-Energy Pulse, Mental Disrupter and Signal Jam. The old trapped zone remains only so the frozen v0.3 card data and its tests still run. |
| 3 | Remove trapped/untrapped references | **Done.** Rewrote the texts of Garilian Seer, Fabricator Drone, Railgun Overseer, Convergence Engine and Interference Net. All eligibility checks now use restrictions, and the rulebook and rulings are updated. |
| 4 | Interference Net / Grankor revisions | **Partly done.** Both now run on restrictions (Grankor: all six until escape at Physical + roll ≥ 5 or a second failure; Net: all six until the owner's next Cleanup, printed Physical ≤ 2). **The "previously specified revisions" text was never received.** Send it and both cards can be updated. Parasitic Snare keeps its v0.4.1 text and readiness behaviour. |
| 5a | Atomic Equipment Mechanic payment | **Done.** The Equipment and host are chosen first, then base plus Equipment cost is paid in one payment. The card is only offered when some Equipment is affordable together with the base cost. |
| 5b | Individual Creation Unit selection | **Done.** `Payment.pick` lists exact CU uids and the engine validates them. A new click-to-choose picker cycles each unit through deplete, burn and unused. Burning a fortified CU is now the player's choice. |
| 5c | Choosing between eligible Lock-On users | **Done** (prompt "Lock-On: which unit?"). No current card combination can produce two Lock-On units in one engagement; the test uses a test-only Cyborg. |
| 5d | Marrow Parasite Stack choice | **Done.** Its controller chooses which destroyed member to compare with when the rewards differ. |
| 5e | Equipment relocation AI | **Done.** Moves Equipment off units that can't fight onto ready ones when the gain beats the Relocate cost: 1,373 free and 12 paid moves in 10,000 games. |
| 5f | Browser testing | **Done for:** the CU picker (paid exactly as chosen), the Protocol dialog and marker, the activated-ability button (Fabricator Drone), Grankor targeting/staging/containment marker, keyword captions, Reactive/Creation type lines, the Description hover caption and the card preview. **Not clicked through in the browser:** Lock-On face choice, Calibrate, Marrow choice, Equipment Mechanic. These use the same decision and card-choice dialogs, and their engine flows have automated tests. |
| 6 | AI improvements | **Done:** only ready, unrestricted units count as blockers; a Stack is formed only when its odds against the strongest blocker beat the best single attack (accounting for the two-for-one risk); growth units are attacked with into blocks (Mutation, Alloy, Feeding); resource reservation covers every Reactive Power worth holding, with mixed/Any/burn costs; lethal Cannibalistic Instinct on an unblocked attacker is recognised; Equipment relocation; Lock-On unit choice; Marrow choice. |
| 7 | Card- and mechanic-level telemetry | **Done:** `tools/sim/v041.ts` writes games.csv, matchups.csv, decks.csv, cards.csv and mechanics.csv. |
| 8 | Simulations | **Done:** the 400-game run on the original v0.4 seeds, plus 1,000 games per non-mirror matchup (10,000 games, seats alternating). No errors and no turn-limit games. |

## Still open / known limitations
- Interference Net and Grankor revision text (see 4).
- The fuller earlier v0.4.1 prompt was never received, so I can't confirm nothing else from it is missing.
- Swarm Caller still puts the other revealed cards on the bottom in their existing order (no reorder prompt).
- These costs are still paid automatically with the suggested payment, without the picker: activated abilities, Lock-On, Relocate, and Equipment Mechanic's combined cost.
- Duplicate Davileam Protocols trigger once per Battle phase per controller (interpretation 5).
- AI: Lock-On is used rarely (40 times in 10,000 games), and Grid Marshal almost always picks Guard over Scan.

## Simulation baseline (Normal AI, 15 Lab HP) — reports/v041-original and reports/v041-matchups
- Original 400 seeds: first player 57.8%. Win rates: Swarm 71.3%, Industrial 58.8%, Evolution 53.1%, Control 37.5%, Mixed 29.4%.
- 10,000 games: first player 57.1%, average 11.3 turns. Win rates: Swarm 65.2%, Industrial 62.0%, Evolution 55.8%, Control 34.6%, Mixed 32.4%.
- Matchups (first-named deck's win %): Control–Swarm 18.5, Control–Industrial 31.3, Control–Evolution 31.2, Control–Mixed 57.4, Industrial–Swarm 47.2, Industrial–Evolution 60.1, Industrial–Mixed 72.0, Swarm–Evolution 54.2, Swarm–Mixed 72.4, Evolution–Mixed 68.7.
- Mechanics per game:
  - Stacks formed 0.69, Stack fights 0.39 (2,229 kills, only 64 Stacks lost)
  - Grankor 0.25, Interference Net 0.11, escapes succeeded 1,940 vs 599 failed
  - Calibrate 0.22, Resource Fortification used 0.19, Cannibalize 0.12, Mutation 0.08
  - Reanimated returns 0.07, Feeding 0.085 triggers (228 creations)
  - Lock-On 0.004
- Card outliers (win % in games where the card was played; this reflects when it gets played, not only how strong it is):
  - High: Foundry Titan 82, Xardy Piercer 75, Railgun Overseer 74, Scrap Harvester 74, Robo Refurb 72, Tricapia Guardian 71
  - Low: Grankor 32, Relay Chimera 34, Patchwork Initiate 35, Interface Plating 38, Neural Interface 38, Targeting Node 40

## Observations for the next balance revision (nothing was changed)
1. First-player advantage is steady at about 57%.
2. Robot Control and Mixed Integration trail in almost every matchup; Robot Industrial's Equipment engine (Foundry Titan, Xardy, Railgun) over-performs.
3. Lock-On rarely has an eligible roll. Control's main tool is mostly idle.
4. Grankor usually lasts only one Cleanup: escapes succeed about three times as often as they fail.
5. Mixed Integration's Stacks win their fights (2,229 kills, 64 losses), but the deck still loses. Its cheap Cyborgs (Patchwork, Relay Chimera, Neural Interface) under-perform on their own.
