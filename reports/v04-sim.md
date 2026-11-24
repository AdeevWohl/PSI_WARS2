# v0.4 simulation — 400 games, normal AI, 15 Lab HP

Errors: 0

First player wins 58.5% (draws 0). Turns: average 11.5, median 10, turn-limit stalemates 0. First Battle Unit on turn 2.73 on average. Lab damage per game 19.8.

| Deck | Games | Win rate | Draws |
|---|---|---|---|
| robot-control | 160 | 33.1% | 0 |
| robot-industrial | 160 | 61.3% | 0 |
| creature-swarm | 160 | 72.5% | 0 |
| creature-evolution | 160 | 53.8% | 0 |
| mixed-integration | 160 | 29.4% | 0 |

| Matchup (first-listed deck sits in seat 1) | Games | Seat-1 deck wins | Draws |
|---|---|---|---|
| robot-control vs robot-industrial | 20 | 40.0% | 0 |
| robot-control vs creature-swarm | 20 | 20.0% | 0 |
| robot-control vs creature-evolution | 20 | 25.0% | 0 |
| robot-control vs mixed-integration | 20 | 65.0% | 0 |
| robot-industrial vs robot-control | 20 | 75.0% | 0 |
| robot-industrial vs creature-swarm | 20 | 40.0% | 0 |
| robot-industrial vs creature-evolution | 20 | 60.0% | 0 |
| robot-industrial vs mixed-integration | 20 | 55.0% | 0 |
| creature-swarm vs robot-control | 20 | 95.0% | 0 |
| creature-swarm vs robot-industrial | 20 | 40.0% | 0 |
| creature-swarm vs creature-evolution | 20 | 55.0% | 0 |
| creature-swarm vs mixed-integration | 20 | 90.0% | 0 |
| creature-evolution vs robot-control | 20 | 70.0% | 0 |
| creature-evolution vs robot-industrial | 20 | 40.0% | 0 |
| creature-evolution vs creature-swarm | 20 | 25.0% | 0 |
| creature-evolution vs mixed-integration | 20 | 75.0% | 0 |
| mixed-integration vs robot-control | 20 | 45.0% | 0 |
| mixed-integration vs robot-industrial | 20 | 20.0% | 0 |
| mixed-integration vs creature-swarm | 20 | 15.0% | 0 |
| mixed-integration vs creature-evolution | 20 | 40.0% | 0 |

## Mechanics
```
{
 "lockOns": 4,
 "calibrations": 87,
 "protocolChoices": 343,
 "mutations": {
  "Carrion Foundress": 2,
  "Marrow Parasite": 13,
  "Siana Commander": 3,
  "Mind Leech": 2,
  "Chitin Weaver": 2,
  "Vesper Ripper": 1
 },
 "cannibalized": 47,
 "feedingTriggers": 33,
 "feedingCreations": 9,
 "reanimated": {
  "returned": 23,
  "laterDestroyed": 8,
  "kills": 14
 },
 "stacks": {
  "formed": 333,
  "fights": 180,
  "wins": 95,
  "losses": 6
 },
 "containments": 136,
 "counters": 0,
 "damagePrevented": 0,
 "activations": {
  "Protocol Grid Marshal: Guard": 242,
  "Protocol Davileam Commander: Assault": 38,
  "Fabricator Drone:FabricatorDiscount": 109,
  "Calibrate (Vector Sentinel)": 47,
  "Calibrate (Grid Marshal)": 17,
  "Protocol Davileam Commander: Guard": 60,
  "Lock-On by Therabot Seeker": 3,
  "Protocol Grid Marshal: Scan": 3,
  "Lock-On by Grid Marshal": 1,
  "Calibrate (Tricapia Guardian)": 7,
  "Calibrate (Targeting Node)": 16,
  "Loquidor Stalker:Intercept": 2,
  "Scrap Harvester:HarvestScrap": 14
 }
}
```
## Resources
```
{
 "burnedForCostsPerGame": 0.755,
 "destroyedByEffectsPerGame": 0,
 "creationPhasesWithNoReadyCU": "0.1%"
}
```
## Deck legality
```
{
 "robot-control": [],
 "robot-industrial": [],
 "creature-swarm": [],
 "creature-evolution": [],
 "mixed-integration": []
}
```