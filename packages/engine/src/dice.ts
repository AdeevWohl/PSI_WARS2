import { randInt } from './rng';
import type { Ability, Ctx, DieFace, DieRoll, GameState } from './types';

/** Result of a die face under the game's dice variant (spec §A4). */
export function face(s: GameState, die: Ability, side: number): DieFace {
  // v0.4 Calibrate: side 0 is a fixed +2 with no icons.
  if (side === 0) return { bonus: 2 };
  const table = s.rules.dice[s.config.diceVariant];
  const f = table[die][String(side)];
  if (!f) throw new Error(`no face ${die}/${side}`);
  return f;
}

/** Numeric value of a die: sides 1–5 = 1–5, Obliterate (6) = 4. Used for X, Dark Shredder, Grankor, first player. */
export function numericValue(s: GameState, side: number): number {
  const v = s.rules.dice.numericValue[String(side)];
  if (v === undefined) throw new Error(`bad side ${side}`);
  return v;
}

/** Roll one d6. Clients never call this: only the authoritative engine does. */
export function rollSide(ctx: Ctx): number {
  const s = ctx.s;
  if (s.debugDice.length > 0) return s.debugDice.shift()!;
  return randInt(s.rng, 6) + 1;
}

export function newRoll(side: number): DieRoll {
  return { side, obliterated: false, history: [side] };
}

/** Contribution of a die to its own ability (0 if obliterated). */
export function dieBonus(s: GameState, die: Ability, r: DieRoll | null): number {
  if (!r || r.obliterated) return 0;
  return face(s, die, r.side).bonus;
}

export function dieReroll(s: GameState, die: Ability, r: DieRoll | null): boolean {
  if (!r || r.obliterated) return false;
  return !!face(s, die, r.side).reroll;
}

export function diePhysicalPlus(s: GameState, die: Ability, r: DieRoll | null): number {
  if (!r || r.obliterated) return 0;
  return face(s, die, r.side).physicalPlus ?? 0;
}

export function isObliterate(s: GameState, die: Ability, r: DieRoll | null): boolean {
  return !!r && !!face(s, die, r.side).obliterate;
}

/**
 * Obliteration (§A8 stage a): if exactly one side rolled Obliterate, the other side's die
 * of that type is destroyed. If both did, both are destroyed and neither gets a bonus.
 */
export function applyObliteration(s: GameState, die: Ability, a: DieRoll | null, d: DieRoll | null): 'none' | 'att' | 'def' | 'both' {
  if (!a || !d) return 'none';
  const ao = isObliterate(s, die, a);
  const doo = isObliterate(s, die, d);
  if (ao && doo) {
    a.obliterated = true;
    d.obliterated = true;
    return 'both';
  }
  if (ao) {
    d.obliterated = true;
    return 'att'; // attacker obliterated the defender's die
  }
  if (doo) {
    a.obliterated = true;
    return 'def';
  }
  return 'none';
}
