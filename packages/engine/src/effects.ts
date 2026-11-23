import { CU_TYPES, type Command } from '@psi-wars/shared';
import { shuffleInPlace } from './rng';
import { isDisabled } from './stats';
import { card, defOf, emit, isPowerLike, matchesFilter, moveCard, opponentsOf, player } from './state';
import { ask, register } from './tasks';
import { checkVictory, damageLab } from './victory';
import { damageUnit } from './damage';
import type { Ctx, GameState, Seat, Task } from './types';

/**
 * Card abilities, one implementation per effect id (spec §C2). Adding a card is a data
 * change plus at most one entry here. Battle-time triggers (RollX, ModifyRoll,
 * StaticAura, CyborgStep, TrapEscapeCheck) are read by the battle/cleanup code from
 * card data; the entries below are the ones that resolve as tasks.
 */
export interface EffectImpl {
  /** Power cards: can this be played right now (has something to do)? */
  canPlay?: (s: GameState, seat: Seat, uid: string, params: Record<string, any>) => boolean;
  /** Power cards that need a target chosen on play. */
  targets?: (s: GameState, seat: Seat, uid: string, params: Record<string, any>) => string[];
  run: (ctx: Ctx, t: Task) => void;
}

export interface EffectTask extends Task {
  k: 'effect';
  effect: string;
  controller: Seat;
  source: string;
  params: Record<string, any>;
  target?: string | null;
  opponent?: Seat;
}

const answerChoice = (t: Task): string | null | undefined => {
  const a = t.answer as Command | undefined;
  if (!a) return undefined;
  return a.type === 'ChooseFromList' ? a.choice : null;
};

function shuffleDeck(ctx: Ctx, seat: Seat, deck: 'battleDeck' | 'resourceDeck'): void {
  shuffleInPlace(ctx.s.rng, player(ctx.s, seat)[deck]);
  emit(ctx, { type: 'DeckShuffled', seat, deck });
}

export function removeFromBattle(ctx: Ctx, uid: string, reason: string): void {
  const b = ctx.s.battle;
  if (!b) return;
  for (const a of b.attacks) {
    if (a.status !== 'pending') continue;
    if (a.units.includes(uid)) {
      a.units = a.units.filter((u) => u !== uid);
      if (a.units.length === 0) a.status = 'cancelled';
      emit(ctx, { type: 'RemovedFromBattle', uid, attackId: a.id, role: 'attacker', reason });
    }
    if (a.blockers.includes(uid)) {
      a.blockers = a.blockers.filter((u) => u !== uid);
      emit(ctx, { type: 'RemovedFromBattle', uid, attackId: a.id, role: 'defender', reason });
    }
  }
}

function breakStack(ctx: Ctx, uid: string): void {
  const c = card(ctx.s, uid);
  if (c.stackPartner) {
    const p = card(ctx.s, c.stackPartner);
    p.stackPartner = null;
    c.stackPartner = null;
    emit(ctx, { type: 'Unstacked', uids: [uid, p.uid], reason: 'broken' });
  }
}

export function trapTargets(s: GameState, seat: Seat): string[] {
  const out: string[] = [];
  for (const opp of opponentsOf(s, seat)) out.push(...player(s, opp).lab);
  return out;
}

/** Targets for "deal damage to any target": every Battle Unit in play and every live player's Lab. */
export function damageTargets(s: GameState): string[] {
  const out: string[] = [];
  for (const p of s.players) {
    if (p.eliminated) continue;
    out.push(...p.lab, `lab:${p.seat}`);
  }
  return out;
}

/** A unit destroyed by damage mid-battle leaves its battle. */
function removeIfDestroyed(ctx: Ctx, uid: string, destroyed: boolean): void {
  if (destroyed) removeFromBattle(ctx, uid, 'destroyed');
}

export const EFFECTS: Record<string, EffectImpl> = {
  ReturnFromDiscard: {
    canPlay: (s, seat, _uid, params) => player(s, seat).discard.some((u) => matchesFilter(defOf(s, u), params.filter)),
    run(ctx, t) {
      const e = t as EffectTask;
      const s = ctx.s;
      const choice = answerChoice(t);
      if (choice) {
        moveCard(ctx, choice, 'hand');
        emit(ctx, { type: 'CardReturnedToHand', seat: e.controller, uid: choice, cardId: card(s, choice).cardId, from: 'discard' });
        return;
      }
      const options = player(s, e.controller).discard.filter((u) => matchesFilter(defOf(s, u), e.params.filter));
      if (options.length === 0) {
        emit(ctx, { type: 'EffectFizzled', source: e.source, reason: 'noValidCard' });
        return;
      }
      ask(ctx, { seat: e.controller, kind: 'chooseCard', label: `${defOf(s, e.source).name}: choose a card from your discard pile`, options, info: { source: e.source, zone: 'discard' }, resume: t });
    },
  },

  SearchDeck: {
    run(ctx, t) {
      const e = t as EffectTask;
      const s = ctx.s;
      const choice = answerChoice(t);
      if (choice) {
        moveCard(ctx, choice, 'hand');
        const cardId = card(s, choice).cardId;
        emit(ctx, {
          type: 'CardSearched', seat: e.controller, uid: choice, cardId, to: [e.controller],
          redacted: { type: 'CardSearched', seat: e.controller, cardId },
        });
        shuffleDeck(ctx, e.controller, 'battleDeck');
        return;
      }
      const options = player(s, e.controller).battleDeck.filter((u) => matchesFilter(defOf(s, u), e.params.filter));
      if (options.length === 0) {
        emit(ctx, { type: 'DeckSearched', seat: e.controller, found: false });
        shuffleDeck(ctx, e.controller, 'battleDeck');
        return;
      }
      ask(ctx, { seat: e.controller, kind: 'chooseCard', label: `${defOf(s, e.source).name}: choose a card from your Battle Deck`, options, info: { source: e.source, zone: 'battleDeck' }, resume: t });
    },
  },

  DisableUnits: {
    run(ctx, t) {
      const e = t as EffectTask;
      const s = ctx.s;
      s.turnEffects.push({ kind: 'disable', source: e.source, filter: e.params.filter ?? {} });
      const affected = s.players.flatMap((p) => p.lab).filter((u) => isDisabled(s, u));
      emit(ctx, { type: 'UnitsDisabled', source: e.source, uids: affected });
      if (s.battle) {
        for (const a of s.battle.attacks) {
          if (a.status !== 'pending') continue;
          // A stack is affected if either unit qualifies: the whole fighter leaves.
          if (a.units.some((u) => isDisabled(s, u))) for (const u of [...a.units]) removeFromBattle(ctx, u, 'disabled');
          if (a.blockers.some((u) => isDisabled(s, u))) for (const u of [...a.blockers]) removeFromBattle(ctx, u, 'disabled');
        }
      }
    },
  },

  TrapUnit: {
    targets: (s, seat) => trapTargets(s, seat),
    canPlay: (s, seat) => trapTargets(s, seat).length > 0,
    run(ctx, t) {
      const e = t as EffectTask;
      const s = ctx.s;
      const target = e.target ? s.cards[e.target] : undefined;
      if (!target || target.zone !== 'lab' || target.owner === e.controller || player(s, target.owner).eliminated) {
        emit(ctx, { type: 'TrapFizzled', uid: e.source, target: e.target ?? null });
        return;
      }
      removeFromBattle(ctx, target.uid, 'trapped');
      breakStack(ctx, target.uid);
      moveCard(ctx, target.uid, 'trapped');
      target.trappedBy = e.source;
      moveCard(ctx, e.source, 'attached');
      card(s, e.source).attachedTo = target.uid;
      emit(ctx, { type: 'UnitTrapped', uid: target.uid, cardId: target.cardId, seat: target.owner, trap: e.source, by: e.controller });
    },
  },

  CreationOracle: {
    run(ctx, t) {
      const e = t as EffectTask;
      const s = ctx.s;
      const deck = player(s, e.controller).resourceDeck;
      const choice = answerChoice(t);
      if (choice) {
        const uid = deck.find((u) => card(s, u).cardId === choice);
        if (uid) {
          moveCard(ctx, uid, 'cus');
          card(s, uid).depleted = false;
          emit(ctx, { type: 'CUEntered', seat: e.controller, uid, cardId: choice, via: 'oracle' });
        }
        shuffleDeck(ctx, e.controller, 'resourceDeck');
        return;
      }
      const present = new Set(deck.map((u) => card(s, u).cardId).filter((id) => s.defs[id]?.cardType === 'CreationUnit'));
      const options = CU_TYPES.map((ty) => Object.values(s.defs).find((d) => d.cuType === ty)?.id).filter((id): id is string => !!id && present.has(id));
      if (options.length === 0) {
        emit(ctx, { type: 'DeckSearched', seat: e.controller, found: false, deck: 'resourceDeck' });
        shuffleDeck(ctx, e.controller, 'resourceDeck');
        return;
      }
      ask(ctx, { seat: e.controller, kind: 'chooseCard', label: 'Creation Oracle: choose a Creation Unit type', options, info: { source: e.source, zone: 'resourceDeck', byCardId: true }, resume: t });
    },
  },

  RevealPowerFromHand: {
    run(ctx, t) {
      const e = t as EffectTask;
      const s = ctx.s;
      const opp = e.opponent;
      if (opp === undefined || player(s, opp).eliminated) return;
      const choice = answerChoice(t);
      const hand = player(s, opp).hand;
      if (choice) {
        emit(ctx, { type: 'CardsRevealed', seat: opp, cards: [{ uid: choice, cardId: card(s, choice).cardId }], source: e.source });
        return;
      }
      const powers = hand.filter((u) => isPowerLike(defOf(s, u)));
      if (powers.length === 0) {
        emit(ctx, { type: 'CardsRevealed', seat: opp, cards: hand.map((u) => ({ uid: u, cardId: card(s, u).cardId })), source: e.source, wholeHand: true });
        return;
      }
      ask(ctx, { seat: opp, kind: 'chooseCard', label: `${defOf(s, e.source).name}: choose a Power card to reveal`, options: powers, info: { source: e.source, zone: 'hand', reveal: true }, resume: t });
    },
  },

  TutorToTop: {
    run(ctx, t) {
      const e = t as EffectTask;
      const s = ctx.s;
      const deck = player(s, e.controller).battleDeck;
      if (t.answer !== undefined) {
        const choice = answerChoice(t);
        if (choice && deck.includes(choice)) {
          deck.splice(deck.indexOf(choice), 1);
          shuffleInPlace(s.rng, deck);
          deck.unshift(choice);
          emit(ctx, { type: 'DeckShuffled', seat: e.controller, deck: 'battleDeck' });
          emit(ctx, { type: 'CardTutored', seat: e.controller, uid: choice, cardId: card(s, choice).cardId, to: [e.controller], redacted: { type: 'CardTutored', seat: e.controller } });
        }
        return;
      }
      const options = deck.filter((u) => matchesFilter(defOf(s, u), e.params.filter));
      if (options.length === 0) {
        emit(ctx, { type: 'DeckSearched', seat: e.controller, found: false });
        shuffleDeck(ctx, e.controller, 'battleDeck');
        return;
      }
      ask(ctx, { seat: e.controller, kind: 'chooseCard', label: `${defOf(s, e.source).name}: you may put a card on top of your deck`, options: [...options, null], info: { source: e.source, zone: 'battleDeck', optional: true }, resume: t });
    },
  },

  /** Change Request 1: the opponent discards a Power card of their choice (Jingwa, Nomis). */
  DiscardPowerFromHand: {
    run(ctx, t) {
      const e = t as EffectTask;
      const s = ctx.s;
      const opp = e.opponent;
      if (opp === undefined || player(s, opp).eliminated) return;
      const choice = answerChoice(t);
      const hand = player(s, opp).hand;
      if (choice && hand.includes(choice)) {
        moveCard(ctx, choice, 'discard');
        emit(ctx, { type: 'CardDiscarded', seat: opp, uid: choice, cardId: card(s, choice).cardId, source: e.source, reason: 'ability' });
        return;
      }
      const powers = hand.filter((u) => isPowerLike(defOf(s, u)));
      if (powers.length === 0) {
        // Prove it: the hand is shown, as with the old reveal ability.
        emit(ctx, { type: 'CardsRevealed', seat: opp, cards: hand.map((u) => ({ uid: u, cardId: card(s, u).cardId })), source: e.source, wholeHand: true });
        return;
      }
      if (powers.length === 1) {
        moveCard(ctx, powers[0]!, 'discard');
        emit(ctx, { type: 'CardDiscarded', seat: opp, uid: powers[0], cardId: card(s, powers[0]!).cardId, source: e.source, reason: 'ability' });
        return;
      }
      ask(ctx, { seat: opp, kind: 'chooseCard', label: `${defOf(s, e.source).name}: choose a Power card to discard`, options: powers, info: { source: e.source, zone: 'hand', discard: true }, resume: t });
    },
  },

  /** Change Request 1: search the Battle Deck for a matching card, reveal it, put it into hand, shuffle (optional). */
  TutorToHand: {
    run(ctx, t) {
      const e = t as EffectTask;
      const s = ctx.s;
      const deck = player(s, e.controller).battleDeck;
      if (t.answer !== undefined) {
        const choice = answerChoice(t);
        if (choice && deck.includes(choice)) {
          moveCard(ctx, choice, 'hand');
          emit(ctx, { type: 'CardSearched', seat: e.controller, uid: choice, cardId: card(s, choice).cardId, revealed: true, source: e.source });
        }
        shuffleDeck(ctx, e.controller, 'battleDeck');
        return;
      }
      const options = deck.filter((u) => matchesFilter(defOf(s, u), e.params.filter));
      if (options.length === 0) {
        emit(ctx, { type: 'DeckSearched', seat: e.controller, found: false });
        shuffleDeck(ctx, e.controller, 'battleDeck');
        return;
      }
      ask(ctx, { seat: e.controller, kind: 'chooseCard', label: `${defOf(s, e.source).name}: you may put a card from your deck into your hand`, options: [...options, null], info: { source: e.source, zone: 'battleDeck', optional: true }, resume: t });
    },
  },

  /** Change Request 1: return a destroyed unit to your Lab, changed (Creature Regenerate, Robo Refurb). */
  ReviveToLab: {
    canPlay: (s, seat, _uid, params) => player(s, seat).discard.some((u) => matchesFilter(defOf(s, u), params.filter)),
    run(ctx, t) {
      const e = t as EffectTask;
      const s = ctx.s;
      const choice = answerChoice(t);
      if (choice && player(s, e.controller).discard.includes(choice)) {
        moveCard(ctx, choice, 'lab');
        const c = card(s, choice);
        c.depleted = false;
        c.enteredThisTurn = true;
        const mods = (e.params.mods ?? {})[defOf(s, choice).unitType ?? ''] ?? {};
        c.permMods = { cyber: Number(mods.cyber ?? 0), psionic: Number(mods.psionic ?? 0), physical: Number(mods.physical ?? 0) };
        emit(ctx, { type: 'UnitRevived', seat: e.controller, uid: choice, cardId: c.cardId, mods: c.permMods, source: e.source });
        return;
      }
      const options = player(s, e.controller).discard.filter((u) => matchesFilter(defOf(s, u), e.params.filter));
      if (options.length === 0) {
        emit(ctx, { type: 'EffectFizzled', source: e.source, reason: 'noValidCard' });
        return;
      }
      ask(ctx, { seat: e.controller, kind: 'chooseCard', label: `${defOf(s, e.source).name}: choose a unit to bring back into play`, options, info: { source: e.source, zone: 'discard' }, resume: t });
    },
  },

  /** Change Request 1: deal damage to one target — a Battle Unit in play or a Lab ("lab:<seat>"). */
  DealDamage: {
    targets: (s) => damageTargets(s),
    run(ctx, t) {
      const e = t as EffectTask;
      const s = ctx.s;
      const amount = Number(e.params.amount ?? 1);
      const target = e.target ?? '';
      if (target.startsWith('lab:')) {
        const seat = Number(target.slice(4));
        if (!s.players[seat] || s.players[seat]!.eliminated) return void emit(ctx, { type: 'EffectFizzled', source: e.source, reason: 'targetGone' });
        damageLab(ctx, seat, amount, e.source);
      } else {
        const c = s.cards[target];
        if (!c || c.zone !== 'lab') return void emit(ctx, { type: 'EffectFizzled', source: e.source, reason: 'targetGone' });
        removeIfDestroyed(ctx, target, damageUnit(ctx, target, amount, e.source, 'effect'));
      }
      checkVictory(ctx);
    },
  },

  /** Change Request 1: deal damage to every unit in play of the given types (Bio Pulse, Static Burst). */
  DamageAll: {
    canPlay: (s, seat, _uid, params) => s.players.some((p) => (!params.enemiesOnly || p.seat !== seat) && p.lab.some((u) => matchesFilter(defOf(s, u), params.filter))),
    run(ctx, t) {
      const e = t as EffectTask;
      const s = ctx.s;
      const amount = Number(e.params.amount ?? 1);
      // enemiesOnly: only opponents' units are hit (Bio Pulse, Static Burst).
      const hit = s.players.filter((p) => !e.params.enemiesOnly || p.seat !== e.controller).flatMap((p) => p.lab).filter((u) => matchesFilter(defOf(s, u), e.params.filter));
      emit(ctx, { type: 'SweepDamage', source: e.source, uids: hit, amount });
      for (const u of hit) removeIfDestroyed(ctx, u, damageUnit(ctx, u, amount, e.source, 'effect'));
      checkVictory(ctx);
    },
  },

  /** Change Request 1: the opponent destroys one of their Creation Units of their choice (Lodner Predator). */
  OpponentDestroysCU: {
    run(ctx, t) {
      const e = t as EffectTask;
      const s = ctx.s;
      const opp = e.opponent;
      if (opp === undefined || player(s, opp).eliminated) return;
      const cus = player(s, opp).cus;
      const choice = answerChoice(t);
      const destroy = (uid: string) => {
        const cardId = card(s, uid).cardId;
        moveCard(ctx, uid, 'discard');
        emit(ctx, { type: 'CUDestroyed', seat: opp, uids: [uid], cardIds: [cardId], forUid: e.source, reason: 'ability' });
      };
      if (choice && cus.includes(choice)) return destroy(choice);
      if (cus.length === 0) return void emit(ctx, { type: 'EffectFizzled', source: e.source, reason: 'noValidCard' });
      if (cus.length === 1 || new Set(cus.map((u) => `${card(s, u).cardId}:${card(s, u).depleted}`)).size === 1) return destroy(cus[0]!);
      ask(ctx, { seat: opp, kind: 'chooseCard', label: `${defOf(s, e.source).name}: choose one of your Creation Units to destroy`, options: [...cus], info: { source: e.source, zone: 'cus' }, resume: t });
    },
  },

  DamageLab: {
    run(ctx, t) {
      const e = t as EffectTask;
      if (e.opponent === undefined) return;
      damageLab(ctx, e.opponent, Number(e.params.amount ?? 1), e.source);
      checkVictory(ctx);
    },
  },
};

register('effect', (ctx, t) => {
  const e = t as EffectTask;
  const impl = EFFECTS[e.effect];
  if (!impl) {
    emit(ctx, { type: 'EffectFizzled', source: e.source, reason: `unknown effect ${e.effect}` });
    return;
  }
  impl.run(ctx, t);
});
