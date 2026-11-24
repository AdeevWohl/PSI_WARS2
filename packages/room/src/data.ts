/** Card data bundled into both servers (Worker and Node) from the repo's data/ folder. */
import cardsJson from '../../../data/cards.json';
import rulesJson from '../../../data/rules.json';
import creature from '../../../data/decks/creature-commander.json';
import robot from '../../../data/decks/robot-commander.json';
import v04RobotControl from '../../../data/decks/v04-robot-control.json';
import v04RobotIndustrial from '../../../data/decks/v04-robot-industrial.json';
import v04CreatureSwarm from '../../../data/decks/v04-creature-swarm.json';
import v04CreatureEvolution from '../../../data/decks/v04-creature-evolution.json';
import v04MixedIntegration from '../../../data/decks/v04-mixed-integration.json';

import { buildDefs, type CardDef, type RulesData } from '@psi-wars/engine';
import type { DeckPayload } from '@psi-wars/shared';
import type { RoomOptions } from './room';

export function roomOptions(extra: Partial<RoomOptions> = {}): RoomOptions {
  return {
    defs: buildDefs(cardsJson as unknown as { cards: CardDef[] }),
    baseCards: cardsJson as unknown as { cards: CardDef[] },
    rules: rulesJson as unknown as RulesData,
    starterDecks: [v04RobotControl, v04RobotIndustrial, v04CreatureSwarm, v04CreatureEvolution, v04MixedIntegration, creature, robot].map((d) => ({ name: d.name, battle: d.battle, resource: d.resource }) as DeckPayload),
    ...extra,
  };
}
