# Balance files

A balance file is a small JSON overlay on `data/cards.json`. Only balance values can change:
costs, strengths, Equipment bonuses, ability values (numbers, on/off options, which die or
ability they use), rules text, and whether a card is enabled. Card identity — id, name, type and
which abilities it has — never changes, so any balance file is safe to load.

```json
{
  "format": "psi-wars-balance",
  "version": 1,
  "name": "Robot buff test",
  "notes": "What this pass is trying",
  "cards": {
    "BU_HB": { "stats": { "cyber": 3, "psionic": 0, "physical": 2 } },
    "EQ_CO": { "equip": { "ability": "cyber", "bonus": 3, "allowed": ["Robot", "Cyborg"] } }
  }
}
```

Each card entry holds only the fields that change; a changed field (`cost`, `stats`, `equip`,
`effects`) is given in full.

- **Make one:** open the developer menu (`Ctrl+Shift+D`, or add `?dev` to the address), choose
  **Card editor**, edit, then **Export**. Files placed in this folder show up in the editor's
  preset list.
- **Measure one:** `npm run sim -- --balance data/balance/<file>.json --games 1000`, and compare
  with a run without `--balance` (same `--seed`).
- **Play one online:** the host picks it in the room lobby; everyone in the room plays under it.
