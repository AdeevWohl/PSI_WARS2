/** Turns engine events into battle-log lines. Only ever fed per-seat filtered events. */
import type { GameEvent, Seat } from '@psi-wars/shared';
import type { CardDef, GameView } from '@psi-wars/engine';

export type Verbosity = 'brief' | 'normal' | 'full';

/** Remembers uid -> cardId for public cards so later events can name them. */
export class Namer {
  private ids = new Map<string, string>();
  constructor(private defs: () => Record<string, CardDef>) {}
  learn(view: GameView): void {
    for (const c of Object.values(view.cards)) this.ids.set(c.uid, c.cardId);
  }
  learnEvent(e: GameEvent): void {
    if (typeof e.uid === 'string' && typeof e.cardId === 'string') this.ids.set(e.uid, e.cardId);
    if (Array.isArray(e.cards)) for (const c of e.cards as { uid: string; cardId: string }[]) this.ids.set(c.uid, c.cardId);
  }
  name(uid: unknown): string {
    if (typeof uid !== 'string') return 'a card';
    const id = this.ids.get(uid);
    return (id && this.defs()[id]?.name) || 'a card';
  }
  cardName(cardId: unknown): string {
    return (typeof cardId === 'string' && this.defs()[cardId]?.name) || 'a card';
  }
}

const PHASE: Record<string, string> = { replenish: 'Replenish', draw: 'Draw', creation: 'Creation', battle: 'Battle', cleanup: 'Cleanup' };

export interface LogLine {
  text: string;
  kind?: 'turn' | 'big';
}

export function eventLine(e: GameEvent, names: (s: unknown) => string, n: Namer, viewer: Seat | null, verbosity: Verbosity): LogLine | null {
  const who = (s: unknown) => (s === viewer ? 'You' : names(s));
  const full = verbosity === 'full';
  const brief = verbosity === 'brief';
  switch (e.type) {
    case 'GameStarted':
      return { text: 'Game started.', kind: 'big' };
    case 'FirstPlayerRoll':
      return brief ? null : { text: `First-player roll: ${(e.rolls as any[]).map((r) => `${names(r.seat)} ${r.value}`).join(', ')}` };
    case 'FirstPlayerChosen':
      return { text: `${who(e.seat)} go${e.seat === viewer ? '' : 'es'} first.`, kind: 'big' };
    case 'TurnStarted':
      return { text: `Turn ${e.turn} — ${names(e.seat)}`, kind: 'turn' };
    case 'PhaseChanged':
      return full ? { text: `${PHASE[e.phase as string] ?? e.phase} phase` } : null;
    case 'CardDrawn':
      if (e.deck === 'resource') return { text: `${who(e.seat)} drew ${n.cardName(e.cardId)}.` };
      if (brief) return null;
      return { text: e.cardId ? `${who(e.seat)} drew ${n.cardName(e.cardId)}.` : `${who(e.seat)} drew a card.` };
    case 'DrawSkipped':
      return brief ? null : { text: `${who(e.seat)} skip${e.seat === viewer ? '' : 's'} the first Battle-Deck draw.` };
    case 'CUEntered':
      return brief ? null : { text: `${n.cardName(e.cardId)} entered ${e.seat === viewer ? 'your' : names(e.seat) + "'s"} Lab${e.via === 'oracle' ? ' (Creation Oracle)' : ''}.` };
    case 'CardPlayed':
      return { text: `${who(e.seat)} played ${n.cardName(e.cardId)}${e.target ? ` on ${n.name(e.target)}` : ''}.`, kind: 'big' };
    case 'CUDestroyed':
      return brief ? null : { text: `${who(e.seat)} destroyed ${(e.uids as string[]).length} Creation Unit(s) to pay.` };
    case 'EquipmentMoved':
      return { text: `${who(e.seat)} moved ${n.cardName(e.cardId)} to ${n.name(e.toUnit)}.` };
    case 'EquipmentDiscarded':
      return { text: `${n.cardName(e.cardId)} was discarded${e.reason === 'unitLeftPlay' ? ' with its unit' : ''}.` };
    case 'Stacked':
      return { text: `${who(e.seat)} stacked ${n.name((e.uids as string[])[0])} and ${n.name((e.uids as string[])[1])}.` };
    case 'AttackersDeclared': {
      const a = e.attacks as { id: string; units: string[]; target: number }[];
      if (!a.length) return { text: `${who(e.seat)} declare${e.seat === viewer ? '' : 's'} no attack.` };
      return { text: `${who(e.seat)} attack${e.seat === viewer ? '' : 's'}: ${a.map((x) => `${x.units.map((u) => n.name(u)).join(' + ')} → ${names(x.target)}`).join('; ')}.`, kind: 'big' };
    }
    case 'BlockersAssigned': {
      const b = e.blocks as { blocker: string; attacker: string }[];
      if (!b.length) return { text: `${who(e.seat)} ${e.seat === viewer ? "don't" : "doesn't"} block.` };
      return { text: `${who(e.seat)} block${e.seat === viewer ? '' : 's'}: ${b.map((x) => `${n.name(x.blocker)} blocks ${n.name(x.attacker)}`).join('; ')}.` };
    }
    case 'UnitTrapped':
      return { text: `${n.cardName(e.cardId)} was trapped!`, kind: 'big' };
    case 'TrapFizzled':
      return { text: `A Trap fizzled — its target was no longer legal.` };
    case 'UnitsDisabled':
      return { text: `${(e.uids as string[]).length} unit(s) cannot attack or defend this turn.` };
    case 'RemovedFromBattle':
      return { text: `${n.name(e.uid)} was removed from the battle.` };
    case 'AbilityRoll':
      return { text: `${n.cardName(e.cardId)} rolled ${e.side === 6 ? 'Obliterate' : e.side}.` };
    case 'CardMilled':
      return { text: `${n.cardName(e.cardId)} was destroyed from the top of ${names(e.seat)}'s Resource Deck.` };
    case 'XRolled':
      return { text: `${n.cardName(e.cardId)}: X = ${e.value}.` };
    case 'RollModified':
      return { text: `${n.cardName(e.cardId)} rolled ${e.value}: ${Number(e.delta) > 0 ? '+' : ''}${e.delta} Physical.` };
    case 'Obliterated':
      return { text: `${String(e.die).toUpperCase()} OBLITERATE — ${e.by === 'both' ? 'both dice destroyed' : e.by === 'att' ? "defender's die destroyed" : "attacker's die destroyed"}.`, kind: 'big' };
    case 'Disoriented':
      return { text: `${(e.uids as string[]).map((u) => n.name(u)).join(' + ')} ${((e.uids as string[]).length > 1) ? 'are' : 'is'} Disoriented${e.auto ? ` (no ${e.ability === 'psionic' ? 'Psionic' : 'Cyber'} to fight with)` : e.ability === 'psionic' ? ' (lost the Psionic battle)' : e.ability === 'cyber' ? ' (lost the Cyber battle)' : ''}.` };
    case 'PsionicWin':
      return full ? { text: `Psionic win for the ${e.side === 'att' ? 'attacker' : 'defender'}.` } : null;
    case 'Rerolled':
      return { text: `${who(e.seat)} re-rolled the Physical die: ${e.physical}.` };
    case 'BattleResolved': {
      const a = e.att as any;
      const d = e.def as any;
      return { text: `Battle: ${a.units.map((u: string) => n.name(u)).join(' + ')} ${a.physical.total} vs ${d.units.map((u: string) => n.name(u)).join(' + ')} ${d.physical.total}.` };
    }
    case 'UnitDestroyed':
      return { text: `${n.cardName(e.cardId)} was destroyed.`, kind: 'big' };
    case 'UnblockedHit':
      return null;
    case 'LabDamaged':
      return { text: `${e.seat === viewer ? 'Your' : names(e.seat) + "'s"} Lab takes ${e.amount} damage (${e.hp} HP left).`, kind: 'big' };
    case 'CardsRevealed':
      return { text: `${who(e.seat)} reveal${e.seat === viewer ? '' : 's'} ${(e.cards as { cardId: string }[]).map((c) => n.cardName(c.cardId)).join(', ') || 'an empty hand'}${e.wholeHand ? ' (whole hand)' : ''}.`, kind: 'big' };
    case 'CardReturnedToHand':
      return { text: `${who(e.seat)} returned ${n.cardName(e.cardId)} to hand.` };
    case 'CardSearched':
      return { text: e.cardId ? `${who(e.seat)} searched for ${n.cardName(e.cardId)}.` : `${who(e.seat)} searched their deck.` };
    case 'CardTutored':
      return { text: e.cardId ? `${who(e.seat)} put ${n.cardName(e.cardId)} on top of the deck.` : `${who(e.seat)} put a card on top of their deck.` };
    case 'DeckShuffled':
      return full ? { text: `${who(e.seat)} shuffled.` } : null;
    case 'EscapeAttempt':
      return { text: `${n.cardName(e.cardId)} tries to escape: ${e.physical} + ${e.value} ${e.freed ? `> ${e.threshold} — freed!` : `≤ ${e.threshold} — still trapped.`}` };
    case 'UnitFreed':
      return e.reason === 'trapperEliminated' ? { text: `${n.cardName(e.cardId)} is freed.` } : null;
    case 'OracleKept':
      return brief ? null : { text: `${who(e.seat)} kept the Creation Oracle.` };
    case 'PlayerEliminated':
      return { text: `${names(e.seat)} is out (${e.reason === 'labDestroyed' ? 'Lab destroyed' : e.reason === 'noBattleUnits' ? 'no Battle Units left' : String(e.reason)}).`, kind: 'big' };
    case 'GameOver':
      return { text: (e.draw ? 'The game is a draw.' : `${(e.winners as number[]).map(names).join(', ')} win${(e.winners as number[]).length === 1 && e.winners !== viewer ? 's' : ''}!`), kind: 'big' };
    case 'UnitDamaged':
      return { text: e.lethal ? `${n.cardName(e.cardId)} takes ${e.amount} damage — destroyed.` : `${n.cardName(e.cardId)} takes ${e.amount} damage — ${e.physicalAfter} Physical left this turn.`, kind: 'big' };
    case 'SweepDamage':
      return { text: `${n.name(e.source)} hits ${(e.uids as string[]).length} unit${(e.uids as string[]).length === 1 ? '' : 's'} for ${e.amount} damage.` };
    case 'CardDiscarded':
      return { text: `${who(e.seat)} discard${e.seat === viewer ? '' : 's'} ${n.cardName(e.cardId)}.`, kind: 'big' };
    case 'UnitRevived': {
      const m = e.mods as { cyber: number; psionic: number; physical: number };
      const parts = (['physical', 'cyber', 'psionic'] as const).filter((k) => m[k]).map((k) => `${m[k] > 0 ? '+' : ''}${m[k]} ${k[0]!.toUpperCase()}${k.slice(1)}`);
      return { text: `${who(e.seat)} brought ${n.cardName(e.cardId)} back into play (${parts.join(', ')}).`, kind: 'big' };
    }
    case 'ResourceFortified':
      return { text: `${who(e.seat)} fortified a Creation Unit.` };
    case 'CUFortified':
      return { text: `A fortified Creation Unit was depleted instead of destroyed.` };
    case 'DeckEmpty':
      return full ? { text: `${who(e.seat)} could not draw: deck empty.` } : null;
    // ---- v0.4 ----
    case 'StatModified':
      return { text: `${n.name(e.uid as string)}: ${Number(e.amount) > 0 ? '+' : ''}${e.amount} ${e.stat}${e.kind === 'mutation' ? ' (Mutation, permanent)' : e.kind === 'reanimated' ? ' (Reanimated, permanent)' : e.kind === 'permanent' ? ' (permanent)' : e.kind === 'stack' ? ' (until the Stack separates)' : ' (this turn)'} — ${e.label}.` };
    case 'LockOn':
      return { text: `${n.name(e.uid as string)} uses Lock-On: ${n.name(e.target as string)}'s ability roll is set to face ${e.side}.` };
    case 'Calibrated':
      return { text: `${n.name(e.uid as string)}: ${e.side === 'att' ? 'attacker' : 'defender'} Calibrates the ${e.die} die (fixed +2).` };
    case 'ProtocolSet':
      return { text: `${n.name(e.uid as string)} Protocol: ${e.mode} — ${e.text}` };
    case 'Cannibalized':
      return { text: `${n.name(e.uid as string)} is Cannibalized (permanent Physical ${e.permanentPhysical}).` };
    case 'FeedingTriggered':
      return { text: `Carrion Foundress feeds: may create a Creature with total cost ≤ ${e.limit}.` };
    case 'Countered':
      return { text: `${n.name(e.uid as string)} is cancelled by ${n.name(e.by as string)}.` };
    case 'DamagePrevented':
      return { text: `${e.amount} damage to ${n.name(e.uid as string)} is prevented.` };
    case 'AbilityActivated':
      return { text: `${n.name(e.uid as string)} activates its ability.` };
    case 'FortificationUsed':
      return { text: 'Resource Fortification saves a Creation Unit and is discarded.' };
    case 'ObliterateIgnored':
      return { text: `Vegian Cyber Shield ignores the Obliterate on ${n.name(e.uid as string)}'s Cyber die.` };
    case 'UnitLinked':
      return { text: `${n.name(e.uid as string)} links to ${n.name(e.linkTo as string)}.` };
    case 'HandLooked':
      return { text: Array.isArray(e.cards) ? `You see their hand: ${(e.cards as { cardId: string }[]).map((c) => names(c.cardId)).join(', ') || 'empty'}.` : 'Their hand was looked at.' };
    case 'UnitJammed':
      return { text: `${n.name(e.uid as string)} is Signal-Jammed this turn.` };
    default:
      return null;
  }
}
