import { card, defOf, matchesFilter, player } from './state';
import { isFortification, isRestricted, staticBonus } from './mods';
import type { Ability, GameState, Seat, StatMods } from './types';

/** Printed/data base value; X resolves to the rolled value, or null if not rolled yet. */
export function baseValue(s: GameState, uid: string, ab: Ability): number | null {
  const d = defOf(s, uid);
  const v = d.stats?.[ab] ?? 0;
  if (v === 'X') return card(s, uid).xValue;
  return v;
}

export function isX(s: GameState, uid: string, ab: Ability): boolean {
  return defOf(s, uid).stats?.[ab] === 'X';
}

export function equipmentBonus(s: GameState, uid: string, ab: Ability): number {
  const eq = card(s, uid).equipment;
  if (!eq) return 0;
  const e = defOf(s, eq).equip;
  // Psi Bolster swapped to Physical for the turn.
  if (s.turnEffects.some((t) => t.kind === 'used' && t.key === `swap:${eq}`)) return ab === 'physical' ? 1 : 0;
  return e && e.ability === ab ? e.bonus : 0;
}

/** Commander auras (§A11): attacking units of the aura's type, controlled by the Commander's owner. */
export function auraBonus(s: GameState, uid: string, ab: Ability): number {
  const c = card(s, uid);
  const d = defOf(s, uid);
  let total = 0;
  for (const cu of player(s, c.owner).lab) {
    if (isRestricted(s, cu, 'passive')) continue; // a restricted Commander grants nothing
    const cd = defOf(s, cu);
    for (const e of cd.effects) {
      if (e.trigger !== 'StaticAura') continue;
      if (e.params.scope === 'attacking' && d.unitType === e.params.unitType) total += e.params.bonus?.[ab] ?? 0;
    }
  }
  return total;
}

/** Current strength of one unit in one ability. X not yet rolled counts as 0 here. */
export function unitStrength(s: GameState, uid: string, ab: Ability, attacking: boolean): number {
  const c = card(s, uid);
  const base = baseValue(s, uid, ab) ?? 0;
  const mods: StatMods = c.tempMods;
  // Change Request 1 (B2): strengths never go below 0.
  const stack = c.stackPartner ? (c.stackMods?.[ab] ?? 0) : 0;
  return Math.max(0, base + equipmentBonus(s, uid, ab) + mods[ab] + (c.permMods?.[ab] ?? 0) + stack + staticBonus(s, uid, ab) + (attacking ? auraBonus(s, uid, ab) : 0));
}

/** A stack's strength is the sum of its cards (§A8 Stacking). */
export function fighterStrength(s: GameState, uids: string[], ab: Ability, attacking: boolean): number {
  return uids.reduce((t, u) => t + unitStrength(s, u, ab, attacking), 0);
}

/** "Has" an ability for battle-occurrence and Equipment rules: X always counts as >= 1. */
export function unitHasAbility(s: GameState, uid: string, ab: Ability): boolean {
  if (isX(s, uid, ab)) return true;
  return (baseValue(s, uid, ab) ?? 0) + equipmentBonus(s, uid, ab) >= 1;
}

/** Equipment eligibility (§A7): allowed type, base ability > 0 (X counts), no Equipment already. */
export function canHoldEquipment(s: GameState, unitUid: string, equipCardId: string): boolean {
  const u = card(s, unitUid);
  if (u.zone !== 'lab' || (u.equipment && !isFortification(s, u.equipment))) return false;
  const ud = defOf(s, unitUid);
  const ed = s.defs[equipCardId]?.equip;
  if (!ed || ud.cardType !== 'BattleUnit' || !ud.unitType) return false;
  if (!ed.allowed.includes(ud.unitType)) return false;
  const v = ud.stats?.[ed.ability] ?? 0;
  return v === 'X' || v > 0;
}

/** Disabled by a "cannot attack or defend for turn" effect (High-Energy Pulse, Mental Disrupter). */
export function isDisabled(s: GameState, uid: string): boolean {
  const d = defOf(s, uid);
  if (isRestricted(s, uid, 'attack') && isRestricted(s, uid, 'defend')) return true;
  for (const te of s.turnEffects) {
    if (te.kind === 'disableUnits' && te.uids?.includes(uid)) return true;
    if (te.kind !== 'disable') continue;
    const f = te.filter ?? {};
    if (f.hasAbility && !unitHasAbility(s, uid, f.hasAbility)) continue;
    if (!matchesFilter(d, f)) continue;
    return true;
  }
  return false;
}

export function fighterUnits(s: GameState, uid: string): string[] {
  const p = card(s, uid).stackPartner;
  return p ? [uid, p] : [uid];
}

export function battleUnitCount(s: GameState, seat: Seat): number {
  const p = player(s, seat);
  const isUnit = (u: string) => defOf(s, u).cardType === 'BattleUnit';
  return p.lab.length + p.trapped.length + p.hand.filter(isUnit).length + p.battleDeck.filter(isUnit).length;
}
