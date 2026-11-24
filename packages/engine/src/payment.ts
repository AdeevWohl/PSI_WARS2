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
  // v0.4: an explicit burn pool overrides the legacy colour rule.
  if (cost.burnPool && cost.burnPool.length) return CU_TYPES.filter((t) => cost.burnPool!.includes(t));
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
          const rest = { ...after };
          for (const t of CU_TYPES) rest[t] -= destroy[t] ?? 0;
          const burns = cost.burns ?? [];
          const pickBurns = (j: number, got: CUType[]) => {
            if (j === burns.length) {
              const p: Payment = { destroy };
              if (chosen.length) p.choice = [...chosen];
              if (A) p.any = any;
              if (got.length) p.burns = [...got];
              out.push(p);
              return;
            }
            for (const t of new Set(burns[j]!)) {
              if (rest[t] <= 0) continue;
              rest[t]--;
              pickBurns(j + 1, [...got, t]);
              rest[t]++;
            }
          };
          pickBurns(0, []);
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
    for (const t of CU_TYPES) left[t] = ready[t].length - cost[t] - (p.any?.[t] ?? 0) - (p.destroy[t] ?? 0) - (p.choice ?? []).filter((x) => x === t).length - (p.burns ?? []).filter((x) => x === t).length;
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

const payKey = (x: Payment) => [CU_TYPES.map((t) => x.destroy[t] ?? 0).join(','), (x.choice ?? []).join(''), CU_TYPES.map((t) => x.any?.[t] ?? 0).join(','), (x.burns ?? []).join('')].join('|');

export function isValidPayment(s: GameState, seat: Seat, cost: Cost, p: Payment): boolean {
  const k = payKey(p);
  return enumeratePayments(s, seat, cost).some((x) => payKey(x) === k);
}

/** Deplete and destroy CUs. Assumes the payment was validated. Fortified CUs absorb destroys first. */
export function pay(ctx: Ctx, seat: Seat, cost: Cost, p: Payment, forUid: string): string[] {
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
  const burnCount: Partial<Record<CUType, number>> = { ...p.destroy };
  for (const t of p.burns ?? []) burnCount[t] = (burnCount[t] ?? 0) + 1;
  for (const t of CU_TYPES) {
    for (let i = 0; i < (burnCount[t] ?? 0); i++) {
      const fort = ready[t].findIndex((u) => isFortified(s, u));
      const uid = fort >= 0 ? ready[t].splice(fort, 1)[0]! : ready[t].pop()!;
      if (fort >= 0) {
        card(s, uid).depleted = true;
        fortified.push(uid);
        // v0.4: Resource Fortification is one-use — discarded once it saves the CU.
        const eq = card(s, uid).equipment;
        if (eq) {
          card(s, uid).equipment = null;
          card(s, eq).attachedTo = null;
          moveCard(ctx, eq, 'discard');
          emit(ctx, { type: 'FortificationUsed', seat, uid: eq, cu: uid, cardId: card(s, eq).cardId });
        }
      } else destroyed.push(uid);
    }
  }
  const destroyedIds = destroyed.map((u) => card(s, u).cardId);
  for (const uid of destroyed) moveCard(ctx, uid, 'discard');
  if (depleted.length) emit(ctx, { type: 'CUDepleted', seat, uids: depleted, forUid });
  if (fortified.length) emit(ctx, { type: 'CUFortified', seat, uids: fortified, forUid });
  if (destroyed.length) emit(ctx, { type: 'CUDestroyed', seat, uids: destroyed, cardIds: destroyedIds, forUid });
  return [...depleted, ...fortified];
}

/** v0.4 printed total cost: every required CU counts once (burns and mixed lights included). */
export function totalCost(cost: Cost | undefined): number {
  if (!cost) return 0;
  return cost.G + cost.B + cost.R + cost.P + cost.W + (cost.A ?? 0) + (cost.choice?.length ?? 0) + (cost.burns?.length ?? 0);
}

/** Only the burn part of a cost (Carrion Foundress waives depletion but keeps every burn). */
export function burnOnly(cost: Cost): Cost {
  const pool = eligibleDestroyTypes(cost);
  return { G: 0, B: 0, R: 0, P: 0, W: cost.W, burnPool: pool };
}

/** Cost with one fewer P (Fabricator Drone): a fixed P first, else a mixed light that allows P. */
export function lessOneP(cost: Cost): Cost {
  const c: Cost = { ...cost, choice: cost.choice ? cost.choice.map((x) => [...x]) : undefined };
  if (totalCost(c) <= 1) return c;
  if (c.P > 0) c.P--;
  else if (c.choice) {
    const i = c.choice.findIndex((x) => x.includes('P'));
    if (i >= 0) c.choice.splice(i, 1);
  }
  return c;
}

export function addCosts(a: Cost, b: Cost): Cost {
  const out: Cost = { G: a.G + b.G, B: a.B + b.B, R: a.R + b.R, P: a.P + b.P, W: a.W, A: (a.A ?? 0) + (b.A ?? 0) };
  if (a.W) out.burnPool = eligibleDestroyTypes(a);
  const ch = [...(a.choice ?? []), ...(b.choice ?? [])];
  if (ch.length) out.choice = ch;
  // Each extra burn keeps its own permitted pool; one CU never pays for two components.
  const burns = [...(a.burns ?? []), ...(b.burns ?? [])];
  for (let i = 0; i < b.W; i++) burns.push(eligibleDestroyTypes(b));
  if (burns.length) out.burns = burns;
  return out;
}
