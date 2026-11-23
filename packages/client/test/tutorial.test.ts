// The guided first game depends on a fixed seed (data/tutorial.json). If cards, decks or rules
// change, the seed may stop producing the intended opening; this test catches that
// (re-run tools/dev/tutorial-seed.ts to pick a new one).
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyCommand, buildDefs, chooseCommand, createGame, defaultCommandFor, getLegalView, seedRng, viewFor, type GameState, type RulesData } from '@psi-wars/engine';

const ROOT = resolve(__dirname, '..', '..', '..');
const read = (p: string) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));
const defs = buildDefs(read('data/cards.json'));
const rules: RulesData = read('data/rules.json');
const cfg = read('data/tutorial.json');
const deck = (id: string) => ({ id, ...read(`data/decks/${id}.json`) });

describe('tutorial seed', () => {
  it('player goes first, sees no Oracle decision on turn 1, and can afford a Battle Unit on turn 3', () => {
    let { state } = createGame({
      defs, rules, seed: cfg.seed, startingHP: cfg.startingHP, autoPassNoPlay: true,
      players: [{ name: 'You', deck: deck(cfg.playerDeck) }, { name: 'AI', deck: deck(cfg.aiDeck) }],
    });
    expect(state.turn.firstPlayer).toBe(0);
    const rng = seedRng(cfg.aiSeed);
    const step = (s: GameState): GameState => {
      const p = s.prompt!;
      const cmd = p.seat === 1 ? chooseCommand(cfg.aiLevel, viewFor(s, 1), getLegalView(s, 1)!, rules, rng) : defaultCommandFor(p);
      const r = applyCommand(s, p.seat, cmd);
      if (!r.ok) throw new Error(r.error);
      return r.state;
    };
    let guard = 0;
    while (!(state.prompt?.seat === 0 && state.prompt.kind === 'main') && guard++ < 50) {
      expect(state.prompt?.kind).not.toBe('oracle');
      state = step(state);
    }
    expect(state.turn.number).toBe(1);
    // The player passes turn 1 (nothing is affordable) and the computer takes turn 2.
    expect(getLegalView(state, 0)!.plays.some((p) => defs[p.cardId]!.cardType === 'BattleUnit')).toBe(false);
    guard = 0;
    do state = step(state);
    while (!(state.prompt?.seat === 0 && state.prompt.kind === 'main' && state.turn.number >= 3) && !state.result && guard++ < 400);
    expect(state.turn.number).toBe(3);
    expect(getLegalView(state, 0)!.plays.some((p) => defs[p.cardId]!.cardType === 'BattleUnit')).toBe(true);
  });
});
