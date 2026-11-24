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
