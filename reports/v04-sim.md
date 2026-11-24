# v0.4 simulation — 400 games, normal AI, 15 Lab HP

Errors: 0

First player wins 57.3% (draws 0). Turns: average 11.7, median 10, turn-limit stalemates 0. First Battle Unit on turn 2.73 on average. Lab damage per game 19.8.

| Deck | Games | Win rate | Draws |
|---|---|---|---|
| robot-control | 160 | 33.8% | 0 |
| robot-industrial | 160 | 61.9% | 0 |
| creature-swarm | 160 | 71.9% | 0 |
| creature-evolution | 160 | 51.2% | 0 |
| mixed-integration | 160 | 31.3% | 0 |

| Matchup (first-listed deck sits in seat 1) | Games | Seat-1 deck wins | Draws |
|---|---|---|---|
| robot-control vs robot-industrial | 20 | 40.0% | 0 |
| robot-control vs creature-swarm | 20 | 20.0% | 0 |
| robot-control vs creature-evolution | 20 | 25.0% | 0 |
| robot-control vs mixed-integration | 20 | 70.0% | 0 |
| robot-industrial vs robot-control | 20 | 80.0% | 0 |
| robot-industrial vs creature-swarm | 20 | 40.0% | 0 |
| robot-industrial vs creature-evolution | 20 | 60.0% | 0 |
| robot-industrial vs mixed-integration | 20 | 50.0% | 0 |
| creature-swarm vs robot-control | 20 | 95.0% | 0 |
| creature-swarm vs robot-industrial | 20 | 35.0% | 0 |
| creature-swarm vs creature-evolution | 20 | 60.0% | 0 |
| creature-swarm vs mixed-integration | 20 | 85.0% | 0 |
| creature-evolution vs robot-control | 20 | 65.0% | 0 |
| creature-evolution vs robot-industrial | 20 | 40.0% | 0 |
| creature-evolution vs creature-swarm | 20 | 25.0% | 0 |
| creature-evolution vs mixed-integration | 20 | 65.0% | 0 |
| mixed-integration vs robot-control | 20 | 45.0% | 0 |
| mixed-integration vs robot-industrial | 20 | 20.0% | 0 |
| mixed-integration vs creature-swarm | 20 | 15.0% | 0 |
| mixed-integration vs creature-evolution | 20 | 40.0% | 0 |

## Mechanics
```
{
 "lockOns": 3,
 "calibrations": 105,
 "protocolChoices": 359,
 "mutations": {
  "Carrion Foundress": 1,
  "Marrow Parasite": 15,
  "Siana Commander": 3,
  "Chitin Weaver": 3,
  "Rupture Brute": 2,
  "Vesper Ripper": 1
 },
 "cannibalized": 0,
 "feedingTriggers": 32,
 "feedingCreations": 9,
 "reanimated": {
  "returned": 24,
  "laterDestroyed": 10,
  "kills": 8
 },
 "stacks": {
  "formed": 389,
  "fights": 226,
  "wins": 116,
  "losses": 5
 },
 "containments": 163,
 "counters": 0,
 "damagePrevented": 0,
 "activations": {
  "Protocol Grid Marshal: Guard": 261,
  "Protocol Davileam Commander: Assault": 42,
  "Fabricator Drone:FabricatorDiscount": 164,
  "Calibrate (Vector Sentinel)": 49,
  "Calibrate (Grid Marshal)": 21,
  "Protocol Davileam Commander: Guard": 53,
  "Protocol Grid Marshal: Scan": 3,
  "Lock-On by Therabot Seeker": 2,
  "Lock-On by Grid Marshal": 1,
  "Calibrate (Tricapia Guardian)": 9,
  "Calibrate (Targeting Node)": 26,
  "Loquidor Stalker:Intercept": 2,
  "Scrap Harvester:HarvestScrap": 14
 }
}
```
## Resources
```
{
 "burnedForCostsPerGame": 0.7575,
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