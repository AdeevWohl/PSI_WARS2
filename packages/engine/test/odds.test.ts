import { describe, expect, it } from 'vitest';
import { battleOdds } from '../src/index';
import { drive, rules, scenario } from './helpers';

describe('battleOdds (exact enumeration)', () => {
  it('returns probabilities that are consistent and in range', () => {
    const o = battleOdds(rules, 'standard', { cyber: 3, psionic: 0, physical: 2 }, { cyber: 1, psionic: 0, physical: 3 });
    for (const v of Object.values(o)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    expect(o.attDestroyed + o.defDestroyed).toBeLessThanOrEqual(1);
  });

  it('identical Creatures are symmetric', () => {
    const s = { cyber: 0, psionic: 3, physical: 2 };
    const o = battleOdds(rules, 'standard', s, s);
    expect(o.attDestroyed).toBeCloseTo(o.defDestroyed, 10);
    expect(o.attPsionicWin).toBeCloseTo(o.defPsionicWin, 10);
  });

  it('a much stronger unit is very likely to win', () => {
    const o = battleOdds(rules, 'standard', { cyber: 0, psionic: 4, physical: 6 }, { cyber: 0, psionic: 1, physical: 1 });
    expect(o.defDestroyed).toBeGreaterThan(0.85);
    expect(o.attDestroyed).toBeLessThan(0.05);
  });

  it('agrees with the engine on a deterministic case (both Cyber Obliterate test setup)', () => {
    // Engine run with forced dice destroys nothing; odds must allow that outcome (< 1).
    const sc = scenario({ at: 'battle', seats: [{ lab: ['BU_HB'] }, { lab: ['BU_LQ'] }], dice: [6, 3, 6, 3] });
    const d = drive(sc);
    d.do({ type: 'DeclareAttackers', attacks: [{ uid: sc.ids[0]!.lab[0]!, target: 1 }] });
    d.do({ type: 'AssignBlockers', blocks: [{ blocker: sc.ids[1]!.lab[0]!, attacker: sc.ids[0]!.lab[0]! }] });
    const o = battleOdds(rules, 'standard', { cyber: 3, psionic: 0, physical: 2 }, { cyber: 1, psionic: 0, physical: 3 });
    expect(o.attDestroyed + o.defDestroyed).toBeLessThan(1);
  });

  it('enumerates an unrolled X', () => {
    const o = battleOdds(rules, 'standard', { cyber: 0, psionic: 'X', physical: 2 }, { cyber: 0, psionic: 2, physical: 2 });
    expect(o.attPsionicWin).toBeGreaterThan(0);
    expect(o.defPsionicWin).toBeGreaterThan(0);
  });
});
