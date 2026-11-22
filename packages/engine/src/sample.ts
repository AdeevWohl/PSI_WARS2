import type { Command, Seat } from '@psi-wars/shared';
import { getLegalActions } from './legal';
import { randInt, type RngState } from './rng';
import type { GameState } from './types';

const pick = <T>(r: RngState, xs: readonly T[]): T => xs[randInt(r, xs.length)]!;

/**
 * A uniformly-ish random legal command for the seat holding the prompt.
 * Used by the fuzz test and as a building block for the Easy AI.
 */
export function randomLegalCommand(s: GameState, r: RngState): { seat: Seat; cmd: Command } | null {
  const p = s.prompt;
  if (!p) return null;
  const la = getLegalActions(s, p.seat);
  if (!la) return null;
  const options: Command[] = [];
  for (const pl of la.plays) {
    const payment = pl.payments.length ? pick(r, pl.payments) : undefined;
    const target = pl.targets ? pick(r, pl.targets) : undefined;
    options.push({ type: 'PlayCard', uid: pl.uid, ...(target ? { target } : {}), ...(payment ? { payment } : {}) });
  }
  for (const m of la.moveEquipment) options.push({ type: 'MoveEquipment', equip: m.equip, to: pick(r, m.to) });
  for (const d of la.discardEquipment) if (randInt(r, 4) === 0) options.push({ type: 'DiscardEquipment', equip: d });
  for (const st of la.stacks) options.push({ type: 'Stack', a: st.a, b: st.b });
  for (const u of la.unstacks) options.push({ type: 'Unstack', uid: u });
  if (la.attack) {
    const attacks = la.attack.eligible.filter(() => randInt(r, 2) === 0).map((uid) => ({ uid, target: pick(r, la.attack!.targets) }));
    options.push({ type: 'DeclareAttackers', attacks }, { type: 'DeclareAttackers', attacks });
  }
  if (la.block) {
    const blockers = la.block.blockers.filter(() => randInt(r, 2) === 0);
    const attackers = [...la.block.attackers];
    const blocks = [];
    for (const b of blockers) {
      if (!attackers.length) break;
      const a = attackers.splice(randInt(r, attackers.length), 1)[0]!;
      blocks.push({ blocker: b, attacker: a });
    }
    options.push({ type: 'AssignBlockers', blocks }, { type: 'AssignBlockers', blocks });
  }
  if (la.choices) for (const c of la.choices) options.push({ type: 'ChooseFromList', choice: c });
  if (la.canPass) options.push({ type: 'Pass' }, { type: 'Pass' });
  if (la.canAdvance) options.push({ type: 'AdvancePhase' });
  if (la.canUseAbility) options.push({ type: 'UseAbility', use: true }, { type: 'UseAbility', use: false });
  if (la.canReroll) options.push({ type: 'ChooseReroll', reroll: true }, { type: 'ChooseReroll', reroll: false });
  if (options.length === 0) return null;
  return { seat: p.seat, cmd: pick(r, options) };
}
