// Pure rules engine: no DOM, no network, no timers, no Math.random.
// Importing these modules registers their task handlers.
import './effects';
import './windows';
import './turn';
import './battle';

export * from './types';
export { applyCommand, advance, cloneState, type ApplyResult } from './commands';
export { createGame, buildDefs, type GameSetup, type DeckList } from './setup';
export { getLegalActions, getLegalView, validateCommand, type LegalActions, type LegalView } from './legal';
export { defaultCommandFor } from './tasks';
export { viewFor, filterEvents, unitStatsFor, type GameView, type PlayerView, type PromptView, type UnitStats } from './view';
export { randomLegalCommand } from './sample';
export { seedRng, randInt, shuffleInPlace, type RngState } from './rng';
export { canAfford, shortfall, autoPayment, enumeratePayments, readyCUs } from './payment';
export { unitStrength, fighterStrength, canHoldEquipment, isDisabled, battleUnitCount } from './stats';
export { face, numericValue } from './dice';
export { EFFECTS } from './effects';
export type { PlayOption } from './plays';
