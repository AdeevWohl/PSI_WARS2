/**
 * Damage to Battle Units (Change Request 1, B4): a unit dealt N damage is destroyed if N is at
 * least its current Physical strength; otherwise its Physical strength drops by N until the end
 * of the turn. Used by combat (B3) and by damage cards.
 */
import { unitStrength } from './stats';
import { card, emit, moveCard } from './state';
import type { Ctx } from './types';
import { hooks, preventAbilityDamage } from './mods';

export type DamageCause = 'combat' | 'effect';

/** Returns true if the unit was destroyed. */
export function damageUnit(ctx: Ctx, uid: string, amount: number, source: string | null, cause: DamageCause, attackId?: string): boolean {
  const s = ctx.s;
  const c = s.cards[uid];
  if (!c || (c.zone !== 'lab' && c.zone !== 'trapped') || amount <= 0) return false;
  if (cause === 'effect') {
    amount = preventAbilityDamage(ctx, uid, amount, source);
    if (amount <= 0) return false;
  }
  const physical = unitStrength(s, uid, 'physical', false);
  if (amount >= physical) {
    // A stack only dies together when it is destroyed as a fighter in battle; a single card
    // destroyed by damage just breaks the stack (like a Trap does).
    const partner = c.stackPartner;
    if (partner && s.cards[partner]) s.cards[partner]!.stackPartner = null;
    c.stackPartner = null;
    emit(ctx, { type: 'UnitDamaged', uid, cardId: c.cardId, seat: c.owner, amount, physicalBefore: physical, physicalAfter: 0, source, cause, lethal: true, attackId: attackId ?? null });
    hooks.destroyed?.(ctx, uid, cause === 'combat' ? 'combat' : 'damage');
    moveCard(ctx, uid, 'discard');
    emit(ctx, { type: 'UnitDestroyed', uid, cardId: c.cardId, seat: c.owner, attackId: attackId ?? null, cause: 'damage' });
    return true;
  }
  card(s, uid).tempMods.physical -= amount;
  emit(ctx, { type: 'UnitDamaged', uid, cardId: c.cardId, seat: c.owner, amount, physicalBefore: physical, physicalAfter: unitStrength(s, uid, 'physical', false), source, cause, lethal: false, attackId: attackId ?? null });
  return false;
}
