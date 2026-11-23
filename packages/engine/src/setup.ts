import { numericValue, rollSide } from './dice';
import { seedRng, shuffleInPlace } from './rng';
import { emit, player } from './state';
import { push, run } from './tasks';
import { drawBattleCard } from './turn';
import type { CardDef, CardInstance, Ctx, DiceVariant, GameEvent, GameState, PlayerState, RulesData, Seat } from './types';

export interface DeckList {
  id?: string;
  name?: string;
  battle: Record<string, number>;
  resource: Record<string, number>;
}

export interface GameSetup {
  defs: Record<string, CardDef>;
  rules: RulesData;
  players: { name: string; deck: DeckList }[];
  seed: string;
  startingHP?: number;
  diceVariant?: DiceVariant;
  autoPassNoPlay?: boolean;
  maxTurns?: number;
}

/** Build the card table from cards.json data with an optional balance overlay (Stage 8 card editor). */
export function buildDefs(cardsJson: { cards: CardDef[] }, balance?: { cards?: Record<string, Partial<CardDef>> }): Record<string, CardDef> {
  const out: Record<string, CardDef> = {};
  for (const c of cardsJson.cards) {
    const o = balance?.cards?.[c.id];
    const d = o ? ({ ...structuredClone(c), ...structuredClone(o) } as CardDef) : structuredClone(c);
    // The numbers on the card art: listed under `printed` where they differ from cards.json,
    // otherwise the shipped values. A balance overlay never changes them, so the client can
    // mark every changed number on the card.
    if (o && (o.cost || o.stats) && !c.printed) d.printed = { ...(c.cost ? { cost: structuredClone(c.cost) } : {}), ...(c.stats ? { stats: structuredClone(c.stats) } : {}) };
    out[c.id] = d;
  }
  return out;
}

function expand(list: Record<string, number>): string[] {
  const out: string[] = [];
  for (const id of Object.keys(list).sort()) for (let i = 0; i < list[id]!; i++) out.push(id);
  return out;
}

export function createGame(setup: GameSetup): { state: GameState; events: GameEvent[] } {
  const n = setup.players.length;
  if (n < 2 || n > 4) throw new Error('Psi Wars supports 2 to 4 players');
  const hp = setup.startingHP ?? setup.rules.setup.startingHP.default;
  const s: GameState = {
    engineVersion: 1,
    defs: setup.defs,
    rules: setup.rules,
    config: {
      seed: setup.seed,
      startingHP: hp,
      diceVariant: setup.diceVariant ?? 'standard',
      autoPassNoPlay: setup.autoPassNoPlay ?? false,
      maxTurns: setup.maxTurns ?? 0,
    },
    rng: seedRng(setup.seed),
    debugDice: [],
    players: [],
    cards: {},
    nextUid: 1,
    turn: { number: 0, active: 0, firstPlayer: 0 },
    phase: 'setup',
    step: null,
    battle: null,
    stack: [],
    turnEffects: [],
    tasks: [],
    prompt: null,
    result: null,
    commandCount: 0,
  };
  const ctx: Ctx = { s, events: [] };

  setup.players.forEach((pl, seat) => {
    const p: PlayerState = { seat, name: pl.name, labHP: hp, eliminated: false, battleDeck: [], resourceDeck: [], hand: [], lab: [], cus: [], trapped: [], discard: [] };
    s.players.push(p);
    for (const [deckKey, list] of [['battleDeck', pl.deck.battle], ['resourceDeck', pl.deck.resource]] as const) {
      const ids = expand(list);
      for (const id of ids) if (!s.defs[id]) throw new Error(`deck references unknown card ${id}`);
      // Shuffle before assigning uids so a uid never reveals a card's identity or deck-list position.
      shuffleInPlace(s.rng, ids);
      for (const cardId of ids) {
        const uid = `c${s.nextUid++}`;
        const inst: CardInstance = {
          uid, cardId, owner: seat, zone: deckKey, depleted: false, enteredThisTurn: false,
          equipment: null, attachedTo: null, stackPartner: null, xValue: null,
          tempMods: { cyber: 0, psionic: 0, physical: 0 }, disoriented: false, trappedBy: null,
        };
        s.cards[uid] = inst;
        p[deckKey].push(uid);
      }
      shuffleInPlace(s.rng, p[deckKey]);
    }
  });
  emit(ctx, { type: 'GameStarted', players: s.players.map((p) => ({ seat: p.seat, name: p.name, hp })), seed: setup.seed });

  for (const p of s.players) for (let i = 0; i < s.rules.setup.startingHandSize; i++) drawBattleCard(ctx, p.seat);

  // §A5.6: everyone rolls the red die (Obliterate = 4); highest goes first; re-roll ties.
  let contenders: Seat[] = s.players.map((p) => p.seat);
  for (;;) {
    const rolls = contenders.map((seat) => {
      const side = rollSide(ctx);
      return { seat, side, value: numericValue(s, side) };
    });
    emit(ctx, { type: 'FirstPlayerRoll', rolls });
    const best = Math.max(...rolls.map((r) => r.value));
    contenders = rolls.filter((r) => r.value === best).map((r) => r.seat);
    if (contenders.length === 1) break;
  }
  const first = contenders[0]!;
  s.turn.firstPlayer = first;
  s.turn.active = first;
  emit(ctx, { type: 'FirstPlayerChosen', seat: first, name: player(s, first).name });
  push(ctx, { k: 'startTurn', seat: first });
  run(ctx);
  return { state: s, events: ctx.events };
}
