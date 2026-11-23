/**
 * Exact battle odds by enumerating every die combination (no randomness).
 * Used for the client's "danger rim" glow and as the AI's battle evaluator.
 * Approximations, by design: re-rolls are not taken, optional modify-rolls are ignored,
 * and an X not yet rolled is enumerated over its six faces.
 */
import type { Ability } from '@psi-wars/shared';
import type { DiceTable, RulesData } from './types';

export interface SideStrength {
  cyber: number | 'X';
  psionic: number | 'X';
  physical: number | 'X';
}

export interface BattleOdds {
  /** Probability the attacking side is destroyed. */
  attDestroyed: number;
  /** Probability the defending side is destroyed. */
  defDestroyed: number;
  /** Probability the attacker wins the Psionic battle (for on-win triggers). */
  attPsionicWin: number;
  defPsionicWin: number;
}

const SIDES = [1, 2, 3, 4, 5, 6];

function xValues(rules: RulesData, v: number | 'X'): { value: number; p: number }[] {
  if (v !== 'X') return [{ value: v, p: 1 }];
  return SIDES.map((s) => ({ value: rules.dice.numericValue[String(s)]!, p: 1 / 6 }));
}

export function battleOdds(rules: RulesData, variant: 'standard' | 'noModifier', att: SideStrength, def: SideStrength): BattleOdds {
  const table: DiceTable = rules.dice[variant];
  const f = (die: Ability, side: number) => table[die][String(side)]!;
  const out: BattleOdds = { attDestroyed: 0, defDestroyed: 0, attPsionicWin: 0, defPsionicWin: 0 };
  for (const ac of xValues(rules, att.cyber)) for (const ap of xValues(rules, att.psionic)) for (const ah of xValues(rules, att.physical))
  for (const dc of xValues(rules, def.cyber)) for (const dp of xValues(rules, def.psionic)) for (const dh of xValues(rules, def.physical)) {
    const weight = ac.p * ap.p * ah.p * dc.p * dp.p * dh.p;
    const A = { cyber: ac.value, psionic: ap.value, physical: ah.value };
    const D = { cyber: dc.value, psionic: dp.value, physical: dh.value };
    const cy = A.cyber >= 1 && D.cyber >= 1;
    const ps = A.psionic >= 1 && D.psionic >= 1;
    const dieSets = (on: boolean) => (on ? SIDES : [0]);
    let n = 0;
    const acc = { ad: 0, dd: 0, apw: 0, dpw: 0 };
    for (const acs of dieSets(cy)) for (const dcs of dieSets(cy)) for (const aps of dieSets(ps)) for (const dps of dieSets(ps)) for (const ahs of SIDES) for (const dhs of SIDES) {
      n++;
      // Obliteration per die type
      const obl = (die: Ability, a: number, d: number): [boolean, boolean] => {
        if (!a || !d) return [false, false];
        const ao = !!f(die, a).obliterate;
        const doo = !!f(die, d).obliterate;
        return [doo, ao]; // [attacker's die destroyed, defender's die destroyed]
      };
      const [acX, dcX] = obl('cyber', acs, dcs);
      const [apX, dpX] = obl('psionic', aps, dps);
      const [ahX, dhX] = obl('physical', ahs, dhs);
      const bonus = (die: Ability, s: number, dead: boolean) => (!s || dead ? 0 : f(die, s).bonus);
      const plus = (die: Ability, s: number, dead: boolean) => (!s || dead ? 0 : f(die, s).physicalPlus ?? 0);
      let attDis = false;
      let defDis = false;
      if (cy) {
        const ta = A.cyber + bonus('cyber', acs, acX);
        const td = D.cyber + bonus('cyber', dcs, dcX);
        if (ta < td) attDis = true;
        else if (td < ta) defDis = true;
      }
      if (ps) {
        const ta = A.psionic + bonus('psionic', aps, apX);
        const td = D.psionic + bonus('psionic', dps, dpX);
        if (ta > td) acc.apw++;
        else if (td > ta) acc.dpw++;
      }
      const pa = A.physical + bonus('physical', ahs, ahX) + plus('cyber', acs, acX) + plus('psionic', aps, apX);
      const pd = D.physical + bonus('physical', dhs, dhX) + plus('cyber', dcs, dcX) + plus('psionic', dps, dpX);
      if (pa > pd && !attDis) acc.dd++;
      else if (pd > pa && !defDis) acc.ad++;
    }
    out.attDestroyed += (weight * acc.ad) / n;
    out.defDestroyed += (weight * acc.dd) / n;
    out.attPsionicWin += (weight * acc.apw) / n;
    out.defPsionicWin += (weight * acc.dpw) / n;
  }
  return out;
}
