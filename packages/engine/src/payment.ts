import { CU_TYPES, type CUType, type Payment } from '@psi-wars/shared';
import { card, defOf, emit, moveCard, player } from './state';
import type { Cost, Ctx, GameState, Seat } from './types';

export const ZERO_COST: Cost = { G: 0, B: 0, R: 0, P: 0, W: 0 };

type Counts = Record<CUType, number>;
const zero = (): Counts => ({ G: 0, B: 0, R: 0, P: 0 });

export function readyCUs(s: GameState, seat: Seat): Record<CUType, string[]> {
  const out: Record<CUType, string[]> = { G: [], B: [], R: [], P: [] };
  for (const uid of player(s, seat).cus) {
    const c = card(s, uid);
    const t = defOf(s, uid).cuType;
    if (t && !c.depleted) out[t].push(uid);
  }
  return out;
}

/** A Creation Unit with Resource Fortification attached: destroyed-for-payment means depleted instead. */
export function isFortified(s: GameState, uid: string): boolean {
  const eq = card(s, uid).equipment;
  return !!eq && defOf(s, eq).effects.some((e) => e.effect === 'FortifyResource');
}

/** CU types that may be destroyed for the white cost (§A7 step 3, RULING A7-a): the card's colours, else any. */
export function eligibleDestroyTypes(cost: Cost, _chosen: CUType[] = []): CUType[] {
  // A card's colours include every type on its "pay one of these" lights.
  const coloured = CU_TYPES.filter((t) => cost[t] > 0 || (cost.choice ?? []).some((opts) => opts.includes(t)));
  return coloured.length > 0 ? coloured : [...CU_TYPES];
}

export interface Shortfall {
  type: CUType | 'W' | 'A' | 'choice';
  missing: number;
  options?: CUType[];
}

/** Every distinct legal way to pay a cost (which choice types, which "any" types, which types to destroy). */
export function enumeratePayments(s: GameState, seat: Seat, cost: Cost): Payment[] {
  const ready = readyCUs(s, seat);
  const left = zero();
  for (const t of CU_TYPES) {
    left[t] = ready[t].length - cost[t];
    if (left[t] < 0) return [];
  }
  const out: Payment[] = [];
  const choices = cost.choice ?? [];
  const A = cost.A ?? 0;
  // Spread n units over types without exceeding what's left; calls back with each spread.
  const spread = (n: number, types: readonly CUType[], avail: Counts, cb: (c: Partial<Record<CUType, number>>) => void) => {
    const cur = zero();
    const rec = (i: number, rem: number) => {
      if (i === types.length) {
        if (rem === 0) {
          const o: Partial<Record<CUType, number>> = {};
          for (const t of types) if (cur[t]) o[t] = cur[t];
          cb(o);
        }
        return;
      }
      const t = types[i]!;
      for (let k = 0; k <= Math.min(rem, avail[t]); k++) {
        cur[t] = k;
        rec(i + 1, rem - k);
      }
      cur[t] = 0;
    };
    rec(0, n);
  };
  const pickChoices = (i: number, chosen: CUType[], avail: Counts) => {
    if (i === choices.length) {
      spread(A, CU_TYPES, avail, (any) => {
        const after = { ...avail };
        for (const t of CU_TYPES) after[t] -= any[t] ?? 0;
        const elig = eligibleDestroyTypes(cost, chosen);
        spread(cost.W, elig, after, (destroy) => {
          const p: Payment = { destroy };
          if (chosen.length) p.choice = [...chosen];
          if (A) p.any = any;
          out.push(p);
        });
      });
      return;
    }
    for (const t of new Set(choices[i]!)) {
      if (avail[t] <= 0) continue;
      avail[t]--;
      pickChoices(i + 1, [...chosen, t], avail);
      avail[t]++;
    }
  };
  pickChoices(0, [], left);
  return out;
}

export function canAfford(s: GameState, seat: Seat, cost: Cost): boolean {
  return enumeratePayments(s, seat, cost).length > 0;
}

/** What a player lacks to pay a cost; empty = affordable. */
export function shortfall(s: GameState, seat: Seat, cost: Cost): Shortfall[] {
  const ready = readyCUs(s, seat);
  const out: Shortfall[] = [];
  const left = zero();
  for (const t of CU_TYPES) {
    left[t] = ready[t].length - cost[t];
    if (left[t] < 0) out.push({ type: t, missing: -left[t] });
  }
  if (out.length) return out;
  if (canAfford(s, seat, cost)) return [];
  // Name the first extra part that can't be met, in payment order.
  for (const opts of cost.choice ?? []) {
    const t = opts.filter((x) => left[x] > 0).sort((a, b) => left[b] - left[a])[0];
    if (!t) return [{ type: 'choice', missing: 1, options: [...opts] }];
    left[t]--;
  }
  const total = CU_TYPES.reduce((a, t) => a + left[t], 0);
  if ((cost.A ?? 0) > total) return [{ type: 'A', missing: (cost.A ?? 0) - total }];
  return [{ type: 'W', missing: Math.max(1, cost.W - Math.max(0, total - (cost.A ?? 0))) }];
}

/**
 * Auto-pay suggestion (§C3): deplete the fixed colours, then fill choice lights and "pay any"
 * from the type with the most left, and destroy from the eligible type with the most left —
 * this preserves the most flexible CUs.
 */
export function autoPayment(s: GameState, seat: Seat, cost: Cost): Payment | null {
  const all = enumeratePayments(s, seat, cost);
  if (!all.length) return null;
  const ready = readyCUs(s, seat);
  // Score: the smallest pool left afterwards should be as large as possible, then the spread.
  const score = (p: Payment) => {
    const left = zero();
    for (const t of CU_TYPES) left[t] = ready[t].length - cost[t] - (p.any?.[t] ?? 0) - (p.destroy[t] ?? 0) - (p.choice ?? []).filter((x) => x === t).length;
    const vals = CU_TYPES.map((t) => left[t]).sort((a, b) => a - b);
    return vals[0]! * 1000 + vals[1]! * 100 + vals[2]! * 10 + vals[3]!;
  };
  let best = all[0]!;
  let bestScore = score(best);
  for (const p of all) {
    const sc = score(p);
    if (sc > bestScore) {
      best = p;
      bestScore = sc;
    }
  }
  return best;
}

const payKey = (x: Payment) => [CU_TYPES.map((t) => x.destroy[t] ?? 0).join(','), (x.choice ?? []).join(''), CU_TYPES.map((t) => x.any?.[t] ?? 0).join(',')].join('|');

export function isValidPayment(s: GameState, seat: Seat, cost: Cost, p: Payment): boolean {
  const k = payKey(p);
  return enumeratePayments(s, seat, cost).some((x) => payKey(x) === k);
}

/** Deplete and destroy CUs. Assumes the payment was validated. Fortified CUs absorb destroys first. */
export function pay(ctx: Ctx, seat: Seat, cost: Cost, p: Payment, forUid: string): void {
  const s = ctx.s;
  const ready = readyCUs(s, seat);
  // Depletions use unfortified units first; destroys use fortified units first (they are depleted instead).
  for (const t of CU_TYPES) ready[t].sort((a, b) => Number(isFortified(s, a)) - Number(isFortified(s, b)));
  const depleted: string[] = [];
  const destroyed: string[] = [];
  const fortified: string[] = [];
  const takeDeplete = (t: CUType, n: number) => {
    for (let i = 0; i < n; i++) {
      const uid = ready[t].shift()!;
      card(s, uid).depleted = true;
      depleted.push(uid);
    }
  };
  for (const t of CU_TYPES) takeDeplete(t, cost[t]);
  for (const t of p.choice ?? []) takeDeplete(t, 1);
  for (const t of CU_TYPES) takeDeplete(t, p.any?.[t] ?? 0);
  for (const t of CU_TYPES) {
    for (let i = 0; i < (p.destroy[t] ?? 0); i++) {
      const fort = ready[t].findIndex((u) => isFortified(s, u));
      const uid = fort >= 0 ? ready[t].splice(fort, 1)[0]! : ready[t].pop()!;
      if (fort >= 0) {
        card(s, uid).depleted = true;
        fortified.push(uid);
      } else destroyed.push(uid);
    }
  }
  const destroyedIds = destroyed.map((u) => card(s, u).cardId);
  for (const uid of destroyed) moveCard(ctx, uid, 'discard');
  if (depleted.length) emit(ctx, { type: 'CUDepleted', seat, uids: depleted, forUid });
  if (fortified.length) emit(ctx, { type: 'CUFortified', seat, uids: fortified, forUid });
  if (destroyed.length) emit(ctx, { type: 'CUDestroyed', seat, uids: destroyed, cardIds: destroyedIds, forUid });
}
