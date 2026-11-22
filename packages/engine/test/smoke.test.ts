import { describe, expect, it } from 'vitest';
import { applyCommand, randomLegalCommand, seedRng, viewFor } from '../src/index';
import { newGame } from './helpers';

describe('smoke', () => {
  it('creates a 2-player game and reaches a prompt', () => {
    const { state, events } = newGame('smoke');
    expect(state.prompt).not.toBeNull();
    expect(events.find((e) => e.type === 'FirstPlayerChosen')).toBeTruthy();
    for (const p of state.players) expect(p.hand.length).toBe(5);
    const v = viewFor(state, 0);
    expect(v.players[1]!.hand).toBeNull();
  });

  it('plays a few random games to completion', () => {
    for (let g = 0; g < 5; g++) {
      let { state } = newGame(`smoke-${g}`, { maxTurns: 80 });
      const r = seedRng(`choices-${g}`);
      let steps = 0;
      while (!state.result && steps < 20000) {
        const pick = randomLegalCommand(state, r)!;
        expect(pick).toBeTruthy();
        const res = applyCommand(state, pick.seat, pick.cmd);
        if (!res.ok) throw new Error(`${res.error} ${JSON.stringify(pick.cmd)} ${state.prompt?.kind}`);
        state = res.state;
        steps++;
      }
      expect(state.result).not.toBeNull();
    }
  });
});
