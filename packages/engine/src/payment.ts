import { CU_TYPES, type CUType, type Payment } from '@psi-wars/shared';
import { card, defOf, emit, moveCard, player } from './state';
import type { Cost, Ctx, GameState, Seat } from './types';

export const ZERO_COST: Cost = { G: 0, B: 0, R: 0, P: 0, W: 0 };

export function readyCUs(s: GameState, seat: Seat): Record<CUType, string[]> {
  const out: Record<CUType, string[]> = { G: [], B: [], R: [], P: [] };
  for (const uid of player(s, seat).cus) {
    const c = card(s, uid);
    const t = defOf(s, uid).cuType;
    if (t && !c.depleted) out[t].push(uid);
  }
  return out;
}

/** CU types that may be destroyed for the white cost (§A7 step 3, RULING A7-a). */
export function eligibleDestroyTypes(cost: Cost): CUType[] {
  const coloured = CU_TYPES.filter((t) => cost[t] > 0);
  return coloured.length > 0 ? coloured : [...CU_TYPES];
}

export interface Shortfall {
  type: CUType | 'W';
  missing: number;
}

/** What a player lacks to pay a cost; empty = affordable. */
export function shortfall(s: GameState, seat: Seat, cost: Cost): Shortfall[] {
  const ready = readyCUs(s, seat);
  const out: Shortfall[] = [];
  let spare = 0;
  const elig = eligibleDestroyTypes(cost);
  for (const t of CU_TYPES) {
    const have = ready[t].length;
    if (have < cost[t]) out.push({ type: t, missing: cost[t] - have });
    else if (elig.includes(t)) spare += have - cost[t];
  }
  if (cost.W > spare) out.push({ type: 'W', missing: cost.W - spare });
  return out;
}

export function canAfford(s: GameState, seat: Seat, cost: Cost): boolean {
  return shortfall(s, seat, cost).length === 0;
}

/** Every distinct legal way to distribute the white cost over CU types. */
export function enumeratePayments(s: GameState, seat: Seat, cost: Cost): Payment[] {
  if (!canAfford(s, seat, cost)) return [];
  const ready = readyCUs(s, seat);
  const elig = eligibleDestroyTypes(cost);
  const spare = elig.map((t) => ready[t].length - cost[t]);
  const out: Payment[] = [];
  const cur: number[] = elig.map(() => 0);
  const rec = (i: number, left: number) => {
    if (i === elig.length) {
      if (left === 0) {
        const destroy: Partial<Record<CUType, number>> = {};
        elig.forEach((t, k) => {
          if (cur[k]! > 0) destroy[t] = cur[k]!;
        });
        out.push({ destroy });
      }
      return;
    }
    for (let n = 0; n <= Math.min(left, spare[i]!); n++) {
      cur[i] = n;
      rec(i + 1, left - n);
    }
    cur[i] = 0;
  };
  rec(0, cost.W);
  return out;
}

/**
 * Auto-pay suggestion (§C3): deplete the coloured costs, destroy from the eligible type
 * with the most CUs remaining, one at a time — this preserves the most flexible CUs.
 */
export function autoPayment(s: GameState, seat: Seat, cost: Cost): Payment | null {
  if (!canAfford(s, seat, cost)) return null;
  const ready = readyCUs(s, seat);
  const remaining: Record<CUType, number> = { G: 0, B: 0, R: 0, P: 0 };
  for (const t of CU_TYPES) remaining[t] = ready[t].length - cost[t];
  const elig = eligibleDestroyTypes(cost);
  const destroy: Partial<Record<CUType, number>> = {};
  for (let i = 0; i < cost.W; i++) {
    let best: CUType | null = null;
    for (const t of elig) if (remaining[t] > 0 && (best === null || remaining[t] > remaining[best])) best = t;
    if (!best) return null;
    remaining[best]--;
    destroy[best] = (destroy[best] ?? 0) + 1;
  }
  return { destroy };
}

export function isValidPayment(s: GameState, seat: Seat, cost: Cost, p: Payment): boolean {
  const key = (x: Payment) => CU_TYPES.map((t) => x.destroy[t] ?? 0).join(',');
  const k = key(p);
  return enumeratePayments(s, seat, cost).some((x) => key(x) === k);
}

/** Deplete and destroy CUs. Assumes the payment was validated. */
export function pay(ctx: Ctx, seat: Seat, cost: Cost, p: Payment, forUid: string): void {
  const s = ctx.s;
  const ready = readyCUs(s, seat);
  const depleted: string[] = [];
  const destroyed: string[] = [];
  for (const t of CU_TYPES) {
    const pool = ready[t];
    for (let i = 0; i < cost[t]; i++) {
      const uid = pool.shift()!;
      card(s, uid).depleted = true;
      depleted.push(uid);
    }
    for (let i = 0; i < (p.destroy[t] ?? 0); i++) {
      const uid = pool.shift()!;
      destroyed.push(uid);
    }
  }
  for (const uid of destroyed) moveCard(ctx, uid, 'discard');
  if (depleted.length) emit(ctx, { type: 'CUDepleted', seat, uids: depleted, forUid });
  if (destroyed.length) emit(ctx, { type: 'CUDestroyed', seat, uids: destroyed, cardIds: destroyed.map((u) => card(s, u).cardId), forUid });
}
