import { describe, expect, it } from 'vitest';
import { applyCommand, chooseCommand, getLegalView, seedRng, viewFor, type AiLevel, type GameState } from '../src/index';
import { creatureDeck, defs, robotDeck, rules } from './helpers';
import { createGame } from '../src/index';

export function aiGame(levels: AiLevel[], seed: string, decks = [creatureDeck, robotDeck], maxTurns = 150) {
  let { state } = createGame({ defs, rules, seed, players: levels.map((_, i) => ({ name: `AI${i}`, deck: decks[i % decks.length]! })), autoPassNoPlay: true, maxTurns });
  const rngs = levels.map((_, i) => seedRng(`ai:${seed}:${i}`));
  let n = 0;
  while (!state.result) {
    if (++n > 20000) throw new Error('AI game did not finish');
    const seat = state.prompt!.seat;
    const legal = getLegalView(state, seat)!;
    const cmd = chooseCommand(levels[seat]!, viewFor(state, seat), legal, rules, rngs[seat]!);
    const r = applyCommand(state, seat, cmd);
    if (!r.ok) throw new Error(`AI ${levels[seat]} chose an illegal command: ${r.error} ${JSON.stringify(cmd)} at ${legal.prompt.kind}`);
    state = r.state;
  }
  return state as GameState;
}

describe('AI', () => {
  for (const lv of ['easy', 'normal', 'hard'] as AiLevel[]) {
    it(`${lv} plays only legal commands and finishes games`, () => {
      for (let i = 0; i < 4; i++) {
        const s = aiGame([lv, lv], `legal-${lv}-${i}`);
        expect(s.result).not.toBeNull();
      }
    });
  }

  it('handles 3- and 4-player games, choosing whom to attack', () => {
    const s3 = aiGame(['normal', 'hard', 'easy'], 'mp3');
    const s4 = aiGame(['hard', 'normal', 'easy', 'normal'], 'mp4');
    expect(s3.result).not.toBeNull();
    expect(s4.result).not.toBeNull();
  });

  // Mirror matches (same deck both sides) so deck strength does not mask skill.
  const mirror = (a: AiLevel, b: AiLevel, n: number) => {
    let wins = 0;
    for (let i = 0; i < n; i++) {
      const deck = i % 2 ? creatureDeck : robotDeck;
      const aSeat = (i >> 1) % 2;
      const s = aiGame(aSeat === 0 ? [a, b] : [b, a], `mirror-${a}-${b}-${i}`, [deck, deck]);
      if (s.result!.winners.includes(aSeat)) wins++;
    }
    return wins / n;
  };

  it('Normal beats Easy more often than not (mirror matches)', () => {
    expect(mirror('normal', 'easy', 60)).toBeGreaterThan(0.55);
  }, 120_000);

  it('Hard beats Easy more often than not (mirror matches)', () => {
    expect(mirror('hard', 'easy', 60)).toBeGreaterThan(0.55);
  }, 120_000);
});
