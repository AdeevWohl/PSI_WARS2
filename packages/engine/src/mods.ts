/**
 * v0.4 strength modifiers (leaf module: imports only state/types so stats.ts and damage.ts can use it).
 *
 *  printed    — the card's value (X = the rolled value; for permanent comparisons X counts as 1)
 *  permanent  — printed + permMods (Mutations, Reanimated, upgrades); reset when the unit leaves play
 *  current    — permanent + temporary/battle/stack mods, Equipment, auras, static bonuses, damage
 *
 * Every change goes through addMod so players can inspect why a unit's strengths changed.
 */
import type { Ability, CUType } from '@psi-wars/shared';
import { card, defOf, emit, player } from './state';
import type { CardInstance, Ctx, GameState, ModEntry, StatMods } from './types';

export const ZERO_MODS = (): StatMods => ({ cyber: 0, psionic: 0, physical: 0 });
const PERMANENT_KINDS = new Set(['permanent', 'mutation', 'reanimated']);

export function addMod(ctx: Ctx, uid: string, stat: Ability, amount: number, kind: ModEntry['kind'], source: string | null, label: string): void {
  if (!amount) return;
  const s = ctx.s;
  const c = card(s, uid);
  if (PERMANENT_KINDS.has(kind)) {
    c.permMods ??= ZERO_MODS();
    c.permMods[stat] += amount;
  } else if (kind === 'stack') {
    c.stackMods ??= ZERO_MODS();
    c.stackMods[stat] += amount;
  } else c.tempMods[stat] += amount;
  (c.modLog ??= []).push({ stat, amount, kind, source, label });
  emit(ctx, {
    type: 'StatModified', uid, cardId: c.cardId, seat: c.owner, stat, amount, kind, source,
    sourceCardId: source && s.cards[source] ? s.cards[source]!.cardId : null, label,
  });
}

/** Drop temporary log lines at end of turn (permanent ones stay while the unit is in play). */
export function clearTempLog(c: CardInstance): void {
  if (c.modLog) c.modLog = c.modLog.filter((m) => PERMANENT_KINDS.has(m.kind));
  if (c.modLog && c.modLog.length === 0) delete c.modLog;
  delete c.stackMods;
}

/** Printed value with X counted as 1 (v0.4 rule for permanent-strength comparisons). */
export function printedForCompare(s: GameState, uid: string, ab: Ability): number {
  const v = defOf(s, uid).stats?.[ab] ?? 0;
  return v === 'X' ? 1 : v;
}

/** Permanent strength: printed (X = 1) plus permanent modifiers, floor 0. */
export function permanentStrength(s: GameState, uid: string, ab: Ability): number {
  return Math.max(0, printedForCompare(s, uid, ab) + (card(s, uid).permMods?.[ab] ?? 0));
}

export function hasEffect(s: GameState, uid: string, effect: string): boolean {
  return defOf(s, uid).effects.some((e) => e.effect === effect);
}

export function effectOf(s: GameState, uid: string, effect: string) {
  return defOf(s, uid).effects.find((e) => e.effect === effect);
}

/** A unit can use or grant abilities while it is in the Lab (contained units cannot). */
export function canUseAbilities(s: GameState, uid: string): boolean {
  return s.cards[uid]?.zone === 'lab';
}

/** Signal Jam: no optional activated abilities this turn. */
export function isJammed(s: GameState, uid: string): boolean {
  return s.turnEffects.some((t) => t.kind === 'jam' && t.uids?.includes(uid));
}

export function isFortification(s: GameState, uid: string): boolean {
  return defOf(s, uid).effects.some((e) => e.effect === 'FortifyResource');
}

export function partnerOf(s: GameState, uid: string): string | null {
  return card(s, uid).stackPartner;
}

/** Is the unit fighting a blocked engagement right now? */
export function inBlockedBattle(s: GameState, uid: string): boolean {
  return (s.battle?.attacks ?? []).some((a) => a.status === 'pending' && a.blockers.length > 0 && (a.units.includes(uid) || a.blockers.includes(uid)));
}

/** Conditional printed bonuses (data: trigger "Static", effect "StatBonus"). */
export function staticBonus(s: GameState, uid: string, ab: Ability): number {
  const c = s.cards[uid];
  if (!c || c.zone !== 'lab') return 0;
  let total = 0;
  for (const e of defOf(s, uid).effects) {
    if (e.trigger !== 'Static' || e.effect !== 'StatBonus' || e.params.stat !== ab) continue;
    const w = e.params.when ?? {};
    if (w.equipped && !c.equipment) continue;
    if (w.stackedWith) {
      const p = c.stackPartner;
      if (!p || defOf(s, p).unitType !== w.stackedWith) continue;
    }
    if (w.inBlockedBattle && !inBlockedBattle(s, uid)) continue;
    if (w.linkEquipped) {
      const l = c.link ? s.cards[c.link] : undefined;
      if (!l || l.zone !== 'lab' || !l.equipment) continue;
    }
    total += Number(e.params.bonus ?? 1);
  }
  return total;
}

/**
 * Damage prevention for ability damage (Repair Circuit, Molting, Javarow Protector, Interface Plating).
 * Returns the amount actually dealt and consumes the shields used.
 */
export function preventAbilityDamage(ctx: Ctx, uid: string, amount: number, source: string | null): number {
  const s = ctx.s;
  let left = amount;
  const note = (by: string, n: number) => emit(ctx, { type: 'DamagePrevented', uid, cardId: card(s, uid).cardId, amount: n, by, byCardId: s.cards[by]?.cardId ?? null });
  for (const te of s.turnEffects) {
    if (left <= 0) break;
    if (te.kind !== 'prevent' || !te.uids?.includes(uid) || !te.amount) continue;
    if (te.key && te.key !== source) continue;
    const n = Math.min(left, te.amount);
    te.amount -= n;
    left -= n;
    note(te.source, n);
  }
  // Static shields: once per turn each.
  const c = card(s, uid);
  const shields: string[] = [];
  const p = c.stackPartner;
  if (p) {
    for (const holder of [uid, p]) {
      const d = defOf(s, holder);
      // Javarow Protector: while stacked with a Robot, protects either member.
      if (d.effects.some((e) => e.effect === 'StackShield') && defOf(s, holder === uid ? p : uid).unitType === 'Robot') shields.push(holder);
    }
    // Interface Plating on the Cyborg partner protects the non-Cyborg member.
    const eq = card(s, p).equipment;
    if (eq && defOf(s, eq).effects.some((e) => e.effect === 'PartnerShield') && defOf(s, uid).unitType !== 'Cyborg') shields.push(eq);
  }
  for (const sh of shields) {
    if (left <= 0) break;
    const key = `shield:${sh}`;
    if (s.turnEffects.some((t) => t.kind === 'used' && t.key === key)) continue;
    s.turnEffects.push({ kind: 'used', source: sh, key });
    left -= 1;
    note(sh, 1);
  }
  return Math.max(0, left);
}

/** Per-turn "once" bookkeeping. */
export function usedThisTurn(s: GameState, key: string): boolean {
  return s.turnEffects.some((t) => t.kind === 'used' && t.key === key);
}
export function markUsed(s: GameState, key: string, source = ''): void {
  s.turnEffects.push({ kind: 'used', source, key });
}

export function cuTypeOf(s: GameState, uid: string): CUType | undefined {
  return defOf(s, uid).cuType;
}

export function labCreatures(s: GameState, seat: number): string[] {
  return player(s, seat).lab.filter((u) => defOf(s, u).unitType === 'Creature');
}

/** Late-bound hooks set by v04.ts (avoids import cycles). */
export const hooks: {
  /** Called just before a Battle Unit leaves play by destruction. */
  destroyed?: (ctx: Ctx, uid: string, cause: 'combat' | 'damage' | 'cannibalize' | 'effect') => void;
} = {};
