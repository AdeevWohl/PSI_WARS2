import type { CardDef, CardInstance, Ctx, GameEvent, GameState, PlayerState, Seat, Zone } from './types';

export class EngineError extends Error {}

export function card(s: GameState, uid: string): CardInstance {
  const c = s.cards[uid];
  if (!c) throw new EngineError(`unknown card ${uid}`);
  return c;
}

export function defOf(s: GameState, uid: string): CardDef {
  const c = card(s, uid);
  const d = s.defs[c.cardId];
  if (!d) throw new EngineError(`unknown card definition ${c.cardId}`);
  return d;
}

export function player(s: GameState, seat: Seat): PlayerState {
  const p = s.players[seat];
  if (!p) throw new EngineError(`unknown seat ${seat}`);
  return p;
}

export function emit(ctx: Ctx, ev: GameEvent): void {
  ctx.events.push(ev);
}

const ARRAY_ZONES: Partial<Record<Zone, keyof PlayerState>> = {
  battleDeck: 'battleDeck',
  resourceDeck: 'resourceDeck',
  hand: 'hand',
  lab: 'lab',
  cus: 'cus',
  trapped: 'trapped',
  discard: 'discard',
};

export function zoneArray(s: GameState, seat: Seat, zone: Zone): string[] | null {
  const key = ARRAY_ZONES[zone];
  if (!key) return null;
  return player(s, seat)[key] as string[];
}

export function isInPlay(c: CardInstance): boolean {
  return c.zone === 'lab' || c.zone === 'trapped';
}

/**
 * The single place cards change zone. Keeps per-player arrays and the instance's
 * zone in sync and enforces the attachment invariants:
 *  - a Battle Unit leaving play takes its Equipment to the discard pile (RULING A7-e)
 *  - Equipment can never exist without a unit (Q&A change 4)
 *  - a trapped unit leaving play releases its Trap card to the trapper's discard
 */
export function moveCard(
  ctx: Ctx,
  uid: string,
  zone: Zone,
  opts: { toTop?: boolean; owner?: Seat } = {},
): void {
  const s = ctx.s;
  const c = card(s, uid);
  const fromArr = zoneArray(s, c.owner, c.zone);
  if (fromArr) {
    const i = fromArr.indexOf(uid);
    if (i >= 0) fromArr.splice(i, 1);
  }
  const wasInPlay = isInPlay(c);
  if (s.stack.some((x) => x.uid === uid) && zone !== 'stack') {
    s.stack = s.stack.filter((x) => x.uid !== uid);
  }
  if (opts.owner !== undefined) c.owner = opts.owner;
  c.zone = zone;
  const toArr = zoneArray(s, c.owner, zone);
  if (toArr) {
    if (opts.toTop) toArr.unshift(uid);
    else toArr.push(uid);
  }

  if (zone !== 'attached') c.attachedTo = null;
  const nowInPlay = isInPlay(c);
  if (wasInPlay && !nowInPlay) {
    c.depleted = false;
    c.xValue = null;
    c.disoriented = false;
    c.tempMods = { cyber: 0, psionic: 0, physical: 0 };
    if (c.stackPartner) {
      const p = s.cards[c.stackPartner];
      if (p) p.stackPartner = null;
      c.stackPartner = null;
    }
    if (c.equipment) {
      const eq = c.equipment;
      c.equipment = null;
      const e = s.cards[eq];
      if (e && e.zone === 'attached') {
        e.attachedTo = null;
        moveCard(ctx, eq, zone === 'removed' ? 'removed' : 'discard');
        emit(ctx, { type: 'EquipmentDiscarded', uid: eq, cardId: e.cardId, seat: e.owner, reason: 'unitLeftPlay' });
      }
    }
    if (c.trappedBy) {
      const t = s.cards[c.trappedBy];
      c.trappedBy = null;
      if (t && t.zone === 'attached') {
        t.attachedTo = null;
        moveCard(ctx, t.uid, 'discard');
      }
    }
  }
}

export function liveSeats(s: GameState): Seat[] {
  return s.players.filter((p) => !p.eliminated).map((p) => p.seat);
}

export function nextLiveSeat(s: GameState, from: Seat): Seat {
  const n = s.players.length;
  for (let i = 1; i <= n; i++) {
    const seat = (from + i) % n;
    if (!player(s, seat).eliminated) return seat;
  }
  return from;
}

/** Live seats in turn order starting at `start` (inclusive). */
export function turnOrderFrom(s: GameState, start: Seat): Seat[] {
  const n = s.players.length;
  const out: Seat[] = [];
  for (let i = 0; i < n; i++) {
    const seat = (start + i) % n;
    if (!player(s, seat).eliminated) out.push(seat);
  }
  return out;
}

export function opponentsOf(s: GameState, seat: Seat): Seat[] {
  return liveSeats(s).filter((x) => x !== seat);
}

export function cardView(s: GameState, uid: string): { uid: string; cardId: string } {
  return { uid, cardId: card(s, uid).cardId };
}

export function matchesFilter(def: CardDef, filter: Record<string, any> | undefined): boolean {
  if (!filter) return true;
  if (filter.cardType) {
    const types = Array.isArray(filter.cardType) ? filter.cardType : [filter.cardType];
    if (!types.includes(def.cardType)) return false;
  }
  if (filter.unitType) {
    const types = Array.isArray(filter.unitType) ? filter.unitType : [filter.unitType];
    if (!def.unitType || !types.includes(def.unitType)) return false;
  }
  if (filter.cuType && def.cuType !== filter.cuType) return false;
  return true;
}

export function isPowerLike(def: CardDef): boolean {
  return def.cardType === 'Power' || def.cardType === 'Trap';
}
