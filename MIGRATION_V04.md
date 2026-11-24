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
