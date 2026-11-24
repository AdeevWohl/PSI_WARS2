/**
 * Computer opponents (spec §C5, build prompt §9). Pure and deterministic given its RNG.
 * The AI sees exactly what a human in that seat sees — a filtered GameView plus the legal
 * action list — so it cannot cheat: no opponent hands, no deck order.
 *
 *  Easy   — plays its most expensive affordable unit, attacks with anything not obviously
 *           outclassed, blocks at random.
 *  Normal — heuristic evaluation: maximise board strength, keep Creation Units back for
 *           Traps / High-Energy Pulse when holding them, judge every attacker/blocker pairing
 *           by exact battle odds, attack on positive expected value or for lethal, block when
 *           survival is likely or to prevent lethal, chump-block only to avoid losing.
 *  Hard   — Normal plus a shallow search over attack assignments against the defender's
 *           best replies, trap timing (hold Traps for the opponent's attack), and re-rolls
 *           decided by exact probabilities.
 *
 * Battle evaluation uses exact enumeration (battleOdds) rather than ~200 Monte Carlo
 * samples: same purpose, no sampling noise, and with memoisation it is cheaper.
 */
import { ABILITIES, CU_TYPES, type Command, type CUType, type Payment, type Seat } from '@psi-wars/shared';
import type { LegalView } from './legal';
import { battleOdds, type SideStrength } from './odds';
import { randInt, type RngState } from './rng';
import type { CardDef, RulesData } from './types';
import type { GameView } from './view';

export type AiLevel = 'easy' | 'normal' | 'hard';

type Str = { cyber: number; psionic: number; physical: number };

const oddsCache = new Map<string, ReturnType<typeof battleOdds>>();

function odds(rules: RulesData, variant: 'standard' | 'noModifier', a: SideStrength, d: SideStrength) {
  const key = `${variant}|${a.cyber},${a.psionic},${a.physical}|${d.cyber},${d.psionic},${d.physical}`;
  let o = oddsCache.get(key);
  if (!o) {
    o = battleOdds(rules, variant, a, d);
    if (oddsCache.size > 20000) oddsCache.clear();
    oddsCache.set(key, o);
  }
  return o;
}

class Brain {
  constructor(
    readonly level: AiLevel,
    readonly v: GameView,
    readonly la: LegalView,
    readonly rules: RulesData,
    readonly rng: RngState,
  ) {}

  get me(): Seat {
    return this.la.seat;
  }

  def(uid: string): CardDef {
    return this.v.defs[this.v.cards[uid]!.cardId]!;
  }

  rand(): number {
    return randInt(this.rng, 1_000_000) / 1_000_000;
  }

  // ---------- strength & value ----------

  /** Unit strength; X not yet rolled counts as its average (3). Attacking adds Commander auras. */
  strength(uid: string, attacking: boolean): Str {
    const st = this.v.unitStats[uid];
    const out: Str = { cyber: 0, psionic: 0, physical: 0 };
    if (!st) return out;
    for (const ab of ABILITIES) out[ab] = st[ab] === 'X' ? 3 : (st[ab] as number);
    if (attacking && !st.attacking) {
      const owner = this.v.cards[uid]!.owner;
      const d = this.def(uid);
      for (const c of this.v.players[owner]!.lab) {
        for (const e of this.def(c).effects) {
          if (e.trigger === 'StaticAura' && e.params.unitType === d.unitType) for (const ab of ABILITIES) out[ab] += e.params.bonus?.[ab] ?? 0;
        }
      }
    }
    return out;
  }

  fighterStrength(uids: string[], attacking: boolean): Str {
    const out: Str = { cyber: 0, psionic: 0, physical: 0 };
    for (const u of uids) {
      const s = this.strength(u, attacking);
      for (const ab of ABILITIES) out[ab] += s[ab];
    }
    return out;
  }

  fighter(uid: string): string[] {
    const p = this.v.cards[uid]?.stackPartner;
    return p ? [uid, p] : [uid];
  }

  unitValue(uid: string): number {
    const s = this.strength(uid, false);
    const d = this.def(uid);
    let v = s.cyber * 0.6 + s.psionic * 0.6 + s.physical * 1.1;
    if (d.isCommander) v += 3;
    if (d.effects.some((e) => e.trigger === 'OnDestroyEnemyUnit' || e.trigger.startsWith('On'))) v += 0.8;
    return v;
  }

  cardStaticValue(d: CardDef): number {
    if (d.cardType === 'BattleUnit' && d.stats) {
      const n = (x: number | 'X') => (x === 'X' ? 3 : x);
      let v = n(d.stats.cyber) * 0.6 + n(d.stats.psionic) * 0.6 + n(d.stats.physical) * 1.1;
      if (d.isCommander) v += 3;
      return v;
    }
    if (d.cardType === 'Equipment' && d.equip) return d.equip.bonus * (d.equip.ability === 'physical' ? 1.1 : 0.7);
    return 1;
  }

  costSize(d: CardDef): number {
    const c = d.cost;
    return c ? c.G + c.B + c.R + c.P + c.W * 1.5 : 0;
  }

  opponents(): Seat[] {
    return this.v.players.filter((p) => !p.eliminated && p.seat !== this.me).map((p) => p.seat);
  }

  readyCUs(): Record<CUType, number> {
    const out: Record<CUType, number> = { G: 0, B: 0, R: 0, P: 0 };
    for (const u of this.v.players[this.me]!.cus) {
      const t = this.def(u).cuType;
      if (t && !this.v.cards[u]!.depleted) out[t]++;
    }
    return out;
  }

  /** Would paying for `d` still leave enough to cast the reserve card? */
  leavesReserve(d: CardDef, reserve: CardDef | null): boolean {
    if (!reserve?.cost || !d.cost) return true;
    const r = this.readyCUs();
    const size = (c: NonNullable<CardDef['cost']>) => (c.choice?.length ?? 0) + (c.A ?? 0) + c.W + (c.burns?.length ?? 0);
    for (const t of CU_TYPES) r[t] -= d.cost[t];
    let spare = 0;
    for (const t of CU_TYPES) {
      if (r[t] < 0) return false;
      spare += r[t];
    }
    spare -= size(d.cost);
    // The reserve's fixed colours must still be there; its flexible parts come out of the spare pool.
    for (const t of CU_TYPES) if (r[t] < reserve.cost[t]) return false;
    const need = CU_TYPES.reduce((n, t) => n + reserve.cost![t], 0) + size(reserve.cost);
    return spare >= need;
  }

  // ---------- decision entry ----------

  decide(): Command {
    const p = this.la.prompt;
    switch (p.kind) {
      case 'main':
        return this.main();
      case 'declareAttackers':
        return this.attack();
      case 'declareBlockers':
        return this.block();
      case 'priority':
        return this.priority();
      case 'oracle':
        return { type: 'ChooseFromList', choice: 'use' };
      case 'chooseCard':
        return { type: 'ChooseFromList', choice: this.chooseCard() };
      case 'battleOrder':
        return { type: 'ChooseFromList', choice: this.battleOrder() };
      case 'optionalRoll':
        return { type: 'UseAbility', use: this.optionalRoll() };
      case 'reroll':
        return { type: 'ChooseReroll', reroll: this.reroll() };
      case 'decide':
        return { type: 'ChooseFromList', choice: this.decideToken() };
    }
  }

  // ---------- Creation phase ----------

  private main(): Command {
    const la = this.la;
    const act = this.mainActivation();
    if (act) return act;
    const move = this.relocation();
    if (move) return move;
    if (this.level === 'easy') {
      const units = la.plays.filter((p) => this.v.defs[p.cardId]!.cardType === 'BattleUnit');
      if (units.length) {
        const best = units.sort((a, b) => this.costSize(this.v.defs[b.cardId]!) - this.costSize(this.v.defs[a.cardId]!))[0]!;
        return this.playCmd(best.uid, null, best.suggested);
      }
      const other = la.plays.filter((p) => !isTrapLike(this.v.defs[p.cardId]!));
      if (other.length && this.rand() < 0.35) {
        const p = other[randInt(this.rng, other.length)]!;
        return this.playCmd(p.uid, p.targets ? p.targets[randInt(this.rng, p.targets.length)]! : null, p.suggested);
      }
      return { type: 'AdvancePhase' };
    }

    // Normal / Hard: keep CUs back for an instant if we hold one.
    const hand = this.v.players[this.me]!.hand ?? [];
    const reserve = hand.map((u) => this.def(u)).filter((d) => d.timing === 'Reactive' && (isTrapLike(d) || d.effects.some((e) => ['DisableUnits', 'DisableTargets', 'CounterPulse', 'Molting', 'DepleteUnit', 'PreventDamage', 'ReviveToLab', 'CannibalInstinct', 'PowerRoll'].includes(e.effect)))).sort((a, b) => this.costSize(a) - this.costSize(b))[0] ?? null;

    let best: { score: number; cmd: Command } | null = null;
    for (const p of la.plays) {
      const d = this.v.defs[p.cardId]!;
      let score = -Infinity;
      let target: string | null = null;
      if (d.cardType === 'Resource') {
        score = 50;
        // Resource Fortification: protect the type we have most of (it is destroyed most often).
        if (p.targets) target = this.bestFortifyTarget(p.targets);
      }
      else if (d.cardType === 'BattleUnit') score = 10 + this.cardStaticValue(d) * 2 + this.costSize(d);
      else if (d.cardType === 'Equipment' && p.targets) {
        let bestT = -Infinity;
        for (const t of p.targets) {
          const s = this.unitValue(t) + (this.v.cards[t]!.depleted ? 0 : 1.5);
          if (s > bestT) {
            bestT = s;
            target = t;
          }
        }
        score = 6 + this.cardStaticValue(d) * 2 + bestT * 0.3;
      } else if (d.cardType === 'Power' && !isTrapLike(d)) {
        const pick = this.powerPick(d, p.targets);
        score = pick.score;
        target = pick.target;
      }
      else if (isTrapLike(d) && p.targets) {
        // Hard holds Traps for the opponent's attack; Normal traps a big threat now.
        const t = this.bestTrapTarget(p.targets);
        if (t && (this.level === 'normal' ? t.value >= 5 : t.value >= 8)) {
          score = 4 + t.value;
          target = t.uid;
        }
      }
      if (score === -Infinity) continue;
      if (d !== reserve && d.cardType !== 'Resource' && !this.leavesReserve(d, reserve)) score -= 8;
      // v0.4: keep a Digital Splicing ready for Lock-On when the opponents field ability rolls.
      if (d.cardType !== 'Resource' && this.wantsLockOnReserve() && this.readyCUs().G - (d.cost?.G ?? 0) < 1) score -= 5;
      if (score > 0 && (!best || score > best.score)) best = { score, cmd: this.playCmd(p.uid, target, this.pickPayment(p.payments, p.suggested)) };
    }
    // Equipment moves are rarely worth the risk for a heuristic player; skip.
    return best?.cmd ?? { type: 'AdvancePhase' };
  }

  /** Power cards with targets choose them here; untargeted ones fall back to powerScore. */
  private powerPick(d: CardDef, targets: string[] | null): { score: number; target: string | null } {
    const e = d.effects.find((x) => x.trigger === 'OnPlay');
    if (e?.effect === 'DealDamage' && targets) {
      const amount = Number(e.params.amount ?? 1);
      const opps = this.opponents();
      // Lethal on a Lab wins the game.
      for (const o of opps) if (targets.includes(`lab:${o}`) && this.v.players[o]!.labHP <= amount) return { score: 200, target: `lab:${o}` };
      let best: { score: number; target: string | null } = { score: -Infinity, target: null };
      for (const t of targets) {
        if (t.startsWith('lab:')) continue;
        const c = this.v.cards[t];
        if (!c || c.owner === this.me) continue;
        const phys = this.strength(t, false).physical;
        const v = amount >= phys ? 6 + this.unitValue(t) : amount >= phys - 1 ? 1 : -Infinity;
        if (v > best.score) best = { score: v, target: t };
      }
      if (best.score === -Infinity && this.level !== 'easy') {
        const o = [...opps].sort((a, b) => this.v.players[a]!.labHP - this.v.players[b]!.labHP)[0];
        if (o !== undefined && targets.includes(`lab:${o}`)) best = { score: 2, target: `lab:${o}` };
      }
      return best;
    }
    if (e?.effect === 'DamageAll') {
      const amount = Number(e.params.amount ?? 1);
      const types: string[] = e.params.filter?.unitType ?? [];
      let net = 0;
      for (const pl of this.v.players) {
        if (e.params.enemiesOnly && pl.seat === this.me) continue;
        for (const u of pl.lab) {
          if (!types.includes(this.def(u).unitType ?? '')) continue;
          const kill = amount >= this.strength(u, false).physical;
          const v = kill ? this.unitValue(u) + 2 : 0.5;
          net += pl.seat === this.me ? -v : v;
        }
      }
      return { score: net > 3 ? net : -Infinity, target: null };
    }
    if (e && targets && targets.length) {
      const enemy = targets.filter((x) => !x.startsWith('lab:') && this.v.cards[x] && this.v.cards[x]!.owner !== this.me);
      const mine = targets.filter((x) => this.v.cards[x]?.owner === this.me);
      const engaged = (u: string) => (this.v.battle?.attacks ?? []).some((a) => a.status === 'pending' && a.blockers.length > 0 && (a.units.includes(u) || a.blockers.includes(u)));
      const byValue = (xs: string[]) => [...xs].sort((a, b) => this.unitValue(b) - this.unitValue(a));
      switch (e.effect) {
        case 'DamageTargets': {
          const amount = Number(e.params.amount ?? 1);
          const kills = byValue(enemy).filter((u) => this.strength(u, false).physical <= amount);
          if (kills.length) return { score: 4 + this.unitValue(kills[0]!), target: kills[0]! };
          return { score: enemy.length >= 2 ? 1.5 : -Infinity, target: byValue(enemy)[0] ?? null };
        }
        case 'DisableTargets': {
          const inBattle = this.v.battle ? byValue(enemy.filter(engaged)) : [];
          if (inBattle.length) return { score: 3 + this.unitValue(inBattle[0]!), target: inBattle[0]! };
          const myAttackers = (this.v.players[this.me]!.lab).filter((u) => !this.v.cards[u]!.depleted).length;
          if (!this.v.battle && myAttackers >= 2 && enemy.length) return { score: 2 + this.unitValue(byValue(enemy)[0]!) * 0.5, target: byValue(enemy)[0]! };
          return { score: -Infinity, target: null };
        }
        case 'PowerRoll':
        case 'StackBuff': {
          const t = mine.find(engaged);
          return t ? { score: 3.5, target: t } : { score: -Infinity, target: null };
        }
        case 'CannibalInstinct': {
          // Lethal: an unblocked attacker plus the best spare body's Physical reaches the defender's Lab HP.
          const pend = (this.v.battle?.attacks ?? []).filter((a) => a.status === 'pending' && a.seat === this.me && !a.blockers.length);
          for (const a of pend) {
            const t = a.units.find((u) => mine.includes(u));
            if (!t) continue;
            const spare = this.v.players[this.me]!.lab.filter((u) => u !== t && !a.units.includes(u) && ['Creature', 'Cyborg'].includes(this.def(u).unitType ?? ''));
            const gain = Math.max(0, ...spare.map((u) => this.strength(u, false).physical));
            const dmg = this.fighterStrength(a.units, true).physical + gain;
            if (spare.length && dmg >= this.v.players[a.target]!.labHP) return { score: 200, target: t };
          }
          const t = byValue(mine.filter(engaged))[0];
          return t ? { score: 4, target: t } : { score: -Infinity, target: null };
        }
        case 'DepleteUnit': {
          // Parasitic Snare: knock an engaged enemy out of its fight, or a ready blocker before we attack.
          const ready = enemy.filter((u) => !this.v.cards[u]!.depleted);
          const inFight = byValue(ready.filter(engaged))[0];
          if (inFight) return { score: 4 + this.unitValue(inFight), target: inFight };
          const myAttackers = this.v.players[this.me]!.lab.filter((u) => !this.v.cards[u]!.depleted).length;
          if (!this.v.battle && myAttackers && ready.length) return { score: 2 + this.unitValue(byValue(ready)[0]!) * 0.5, target: byValue(ready)[0]! };
          return { score: -Infinity, target: null };
        }
        case 'SignalJam': {
          const t = enemy.find((u) => engaged(u) && this.def(u).effects.some((x) => ['LockOn', 'PayBoost', 'TargetingNode', 'NomisBoost', 'Intercept'].includes(x.effect)));
          return t ? { score: 3, target: t } : { score: -Infinity, target: null };
        }
        case 'Restrict':
        case 'TrapUnit': {
          const t = this.bestTrapTarget(targets);
          return t && t.value >= 5 ? { score: 4 + t.value, target: t.uid } : { score: -Infinity, target: null };
        }
      }
    }
    return { score: this.powerScore(d), target: null };
  }

  private bestFortifyTarget(targets: string[]): string {
    const count = (t: string) => targets.filter((x) => this.v.cards[x]?.cardId === this.v.cards[t]?.cardId).length;
    return [...targets].sort((a, b) => count(b) - count(a))[0]!;
  }

  private powerScore(d: CardDef): number {
    const e = d.effects.find((x) => x.trigger === 'OnPlay');
    if (!e) return -Infinity;
    const me = this.v.players[this.me]!;
    switch (e.effect) {
      case 'ReturnFromDiscard': {
        const best = me.discard.map((u) => this.def(u)).filter((x) => x.cardType === e.params.filter?.cardType).map((x) => this.cardStaticValue(x));
        return best.length ? 3 + Math.max(...best) : -Infinity;
      }
      case 'SearchDeck':
        return me.battleDeckCount > 0 ? 4 : -Infinity;
      case 'TutorToHand':
        return me.battleDeckCount > 0 ? 3.5 : -Infinity;
      case 'EquipmentMechanic':
      case 'ModularAssembly':
        return 5;
      case 'ReturnUpTo':
        return 3.5;
      case 'SalvageProtocol':
        return Object.values(this.v.cards).some((c) => c.owner === this.me && c.zone === 'cus' && c.depleted) ? 2.5 : -Infinity;
      case 'ReviveToLab': {
        const types: string[] = e.params.filter?.unitType ?? [];
        const best = me.discard.map((u) => this.def(u)).filter((x) => x.cardType === 'BattleUnit' && types.includes(x.unitType ?? '')).map((x) => this.cardStaticValue(x));
        return best.length ? 6 + Math.max(...best) : -Infinity;
      }
      case 'DisableUnits': {
        // Only worth it in our own turn if it stops more of their blockers than our attackers.
        const affected = (uids: string[]) => uids.filter((u) => this.disableHits(e.params.filter, u)).reduce((s, u) => s + this.unitValue(u), 0);
        const mine = affected(me.lab);
        const theirs = this.opponents().reduce((s, o) => s + affected(this.v.players[o]!.lab), 0);
        return theirs - mine > 4 ? theirs - mine : -Infinity;
      }
      default:
        return -Infinity;
    }
  }

  private disableHits(filter: Record<string, any>, uid: string): boolean {
    const d = this.def(uid);
    if (filter.hasAbility) {
      const st = this.v.unitStats[uid];
      const v = st?.[filter.hasAbility as 'cyber'];
      if (!(v === 'X' || (typeof v === 'number' && v >= 1))) return false;
    }
    if (filter.unitType) {
      const types = Array.isArray(filter.unitType) ? filter.unitType : [filter.unitType];
      if (!types.includes(d.unitType)) return false;
    }
    return true;
  }

  private bestTrapTarget(targets: string[]): { uid: string; value: number } | null {
    let best: { uid: string; value: number } | null = null;
    for (const t of targets) {
      const v = this.unitValue(t) + (this.def(t).isCommander ? 3 : 0);
      if (!best || v > best.value) best = { uid: t, value: v };
    }
    return best;
  }

  private playCmd(uid: string, target: string | null, payment: Payment | null | undefined): Command {
    return { type: 'PlayCard', uid, ...(target ? { target } : {}), ...(payment ? { payment } : {}) };
  }

  /** Keep the CU types our hand needs most; the engine's suggestion is a good default. */
  private pickPayment(payments: Payment[], suggested: Payment | null): Payment | null {
    if (payments.length <= 1 || this.level === 'easy') return suggested;
    const need: Record<CUType, number> = { G: 0, B: 0, R: 0, P: 0 };
    for (const u of this.v.players[this.me]!.hand ?? []) {
      const c = this.def(u).cost;
      if (c) for (const t of CU_TYPES) need[t] += c[t];
    }
    let best = suggested;
    let bestScore = Infinity;
    for (const p of payments) {
      const s = CU_TYPES.reduce((n, t) => n + (p.destroy[t] ?? 0) * (1 + need[t]), 0);
      if (s < bestScore) {
        bestScore = s;
        best = p;
      }
    }
    return best;
  }

  // ---------- attacking ----------

  /** Best (for the defender) reply to one attacker: blocker uid or null, and attacker EV. */
  private attackEV(attUnits: string[], defender: Seat, blockers: string[]): { ev: number; blocker: string | null } {
    const sa = this.fighterStrength(attUnits, true);
    const attVal = attUnits.reduce((s, u) => s + this.unitValue(u), 0);
    const hp = this.v.players[defender]!.labHP;
    const dmgValue = (dmg: number) => dmg * (hp <= dmg ? 30 : hp <= 6 ? 1.8 : 1.25);
    let worst = { ev: dmgValue(Math.max(0, sa.physical)), blocker: null as string | null };
    for (const b of blockers) {
      const bu = this.fighter(b);
      const o = odds(this.rules, this.v.config.diceVariant, sa, this.fighterStrength(bu, false));
      const bVal = bu.reduce((s, u) => s + this.unitValue(u), 0);
      const ev = o.defDestroyed * bVal - o.attDestroyed * attVal;
      if (ev < worst.ev) worst = { ev, blocker: b };
    }
    return worst;
  }

  /** Do we hold Lock-On units and face units that make ability rolls? */
  private wantsLockOnReserve(): boolean {
    const mine = this.v.players[this.me]!.lab.some((u) => this.def(u).effects.some((e) => e.effect === 'LockOn' || e.effect === 'ProtocolLockOn'));
    if (!mine) return false;
    return this.opponents().some((o) => this.v.players[o]!.lab.some((u) => this.def(u).effects.some((e) => e.trigger === 'RollX' || e.trigger === 'ModifyRoll')));
  }

  /** v0.4: form a Stack before attacking when the combined fighter is clearly stronger. */
  private stackChoice(): Command | null {
    if (this.level === 'easy') return null;
    // Is a Stack worth it? Compare its odds against the opponent's strongest ready blocker with the two
    // units attacking separately (two attackers can't both be blocked by one unit, but a lone small
    // unit is easy to kill). Synergy cards and a stronger Stack against a big blocker tip the balance.
    const opp = this.opponents()[0];
    const ready = opp === undefined ? [] : this.v.players[opp]!.lab.filter((u) => !this.v.cards[u]!.depleted && !this.disabled(u));
    const strongest = ready.map((u) => this.fighterStrength(this.fighter(u), false)).sort((x, y) => y.physical - x.physical)[0];
    let best: { a: string; b: string; score: number } | null = null;
    for (const s of this.la.stacks) {
      if (this.v.cards[s.a]!.depleted || this.v.cards[s.b]!.depleted) continue;
      const together = this.fighterStrength([s.a, s.b], true);
      const synergy = this.def(s.a).effects.some((e) => ['StackChoice', 'Convergence', 'StatBonus', 'StackShield', 'PartnerReroll', 'AlloyUpgrade'].includes(e.effect)) ? 1.2 : 0;
      let score: number;
      if (!strongest) score = ready.length === 0 ? -1 : 0; // no blockers: two separate hits deal more
      else {
        const vs = (u: string[]) => odds(this.rules, this.v.config.diceVariant, this.fighterStrength(u, true), strongest);
        const st = vs([s.a, s.b]);
        const solo = Math.max(vs([s.a]).defDestroyed - vs([s.a]).attDestroyed, vs([s.b]).defDestroyed - vs([s.b]).attDestroyed);
        // A Stack risks a two-for-one, so it must clearly improve the best single attack.
        score = (st.defDestroyed - st.attDestroyed * 1.6) - solo + synergy * 0.25 + (ready.length >= 2 ? 0.1 : -0.2);
      }
      if (score > 0.2 && together.physical >= 4 && (!best || score > best.score)) best = { ...s, score };
    }
    return best ? { type: 'Stack', a: best.a, b: best.b } : null;
  }

  /** Units that grow by surviving blocked battles (Mutation, Alloy upgrades) are worth exposing to blocks. */
  private growthBonus(uid: string): number {
    const growth = this.def(uid).effects.some((e) => ['MutateOnPsiLoss', 'MarrowMutation', 'AlloyUpgrade', 'Feeding'].includes(e.effect));
    return growth ? 0.25 : 0;
  }

  /** Equipment relocation: move Equipment off a unit that can't fight this turn onto a ready one, when worth its cost. */
  private relocation(): Command | null {
    if (this.level === 'easy') return null;
    let best: { cmd: Command; score: number } | null = null;
    for (const m of this.la.moveEquipment ?? []) {
      const from = this.v.cards[m.equip]?.attachedTo;
      if (!from) continue;
      const fromIdle = this.v.cards[from]!.depleted;
      const costN = m.cost ? m.cost.G + m.cost.B + m.cost.R + m.cost.P + (m.cost.choice?.length ?? 0) + (m.cost.A ?? 0) : 0;
      for (const to of m.to) {
        if (this.v.cards[to]!.depleted) continue;
        const gain = this.unitValue(to) - this.unitValue(from) + (fromIdle ? 2 : 0) - costN * 1.5;
        if (gain > 1.5 && (!best || gain > best.score)) best = { cmd: { type: 'MoveEquipment', equip: m.equip, to }, score: gain };
      }
    }
    return best?.cmd ?? null;
  }

  private attack(): Command {
    const la = this.la;
    const st = this.stackChoice();
    if (st) return st;
    const att = la.attack!;
    const targets = att.targets;
    // Prefer the weakest opponent (lowest HP) — sensible in free-for-all too.
    const target = [...targets].sort((a, b) => this.v.players[a]!.labHP - this.v.players[b]!.labHP)[0]!;
    const blockersOf = (seat: Seat) => this.v.players[seat]!.lab.filter((u, i, arr) => {
      const c = this.v.cards[u]!;
      if (c.stackPartner && arr.indexOf(c.stackPartner) < i) return false;
      // v0.4.1: only ready units can block.
      return !c.depleted && !this.disabled(u);
    });
    const blockers = blockersOf(target);

    if (this.level === 'easy') {
      const strongest = Math.max(0, ...blockers.map((b) => this.fighterStrength(this.fighter(b), false).physical));
      const picks = att.eligible.filter((u) => this.fighterStrength(this.fighter(u), true).physical >= strongest - 1);
      return { type: 'DeclareAttackers', attacks: picks.map((uid) => ({ uid, target })) };
    }

    // Lethal: they can block at most |blockers| attackers; if the rest still kill, go all-in.
    const dmg = att.eligible.map((u) => this.fighterStrength(this.fighter(u), true).physical).sort((a, b) => b - a);
    const unblockedDmg = dmg.slice(blockers.length).reduce((s, x) => s + x, 0);
    if (dmg.length > 0 && unblockedDmg >= this.v.players[target]!.labHP) {
      return { type: 'DeclareAttackers', attacks: att.eligible.map((uid) => ({ uid, target })) };
    }

    if (this.level === 'hard' && att.eligible.length <= 8) return this.searchAttack(att.eligible, target, blockers);

    // Normal: attack with everything, then drop the attacker the defender punishes worst
    // until every remaining attacker has acceptable odds. (Attacking costs nothing on
    // defence: survivors are replenished at Cleanup and depleted units can still block.)
    let set = [...att.eligible];
    while (set.length) {
      const { evs } = this.evaluateAttack(set, target, blockers);
      let worst: string | null = null;
      let worstEv = -0.3;
      for (const [u, ev0] of evs) {
        const ev = ev0 + (blockers.length ? this.growthBonus(u) : 0);
        if (ev < worstEv) { worstEv = ev; worst = u; }
      }
      if (!worst) break;
      set = set.filter((u) => u !== worst);
    }
    return { type: 'DeclareAttackers', attacks: set.map((uid) => ({ uid, target })) };
  }

  /** Defender replies one-to-one, punishing the biggest threats first. */
  private evaluateAttack(set: string[], target: Seat, blockers: string[]): { score: number; evs: Map<string, number> } {
    const free = new Set(blockers);
    const evs = new Map<string, number>();
    let score = 0;
    const order = [...set].sort((a, b) => this.fighterStrength(this.fighter(b), true).physical - this.fighterStrength(this.fighter(a), true).physical);
    for (const u of order) {
      const r = this.attackEV(this.fighter(u), target, [...free]);
      evs.set(u, r.ev);
      score += r.ev;
      if (r.blocker) free.delete(r.blocker);
    }
    return { score, evs };
  }

  /** Hard: try every subset of attackers against the defender's one-to-one replies. */
  private searchAttack(eligible: string[], target: Seat, blockers: string[]): Command {
    let best = { score: 0, set: [] as string[] };
    const n = eligible.length;
    for (let mask = 1; mask < 1 << n; mask++) {
      const set = eligible.filter((_, i) => mask & (1 << i));
      const { score } = this.evaluateAttack(set, target, blockers);
      if (score > best.score) best = { score, set };
    }
    return { type: 'DeclareAttackers', attacks: best.set.map((uid) => ({ uid, target })) };
  }

  private disabled(uid: string): boolean {
    const r = (this.v.cards[uid] as { restrictions?: { kinds: string[] }[] } | undefined)?.restrictions ?? [];
    if (r.some((x) => x.kinds.includes('defend'))) return true;
    return this.v.turnEffects.some((te) => te.kind === 'disable' && this.disableHits(te.filter ?? {}, uid));
  }

  // ---------- blocking ----------

  private block(): Command {
    const la = this.la;
    const blk = la.block!;
    const attacks = (this.v.battle?.attacks ?? []).filter((a) => blk.attackers.includes(a.id));
    const free = new Set(blk.blockers);
    const blocks: { blocker: string; attacker: string }[] = [];

    if (this.level === 'easy') {
      for (const a of attacks) {
        if (!free.size || this.rand() < 0.5) continue;
        const arr = [...free].filter((b) => !blk.forbidden?.some((f) => f.attacker === a.id && f.blocker === b));
        if (!arr.length) continue;
        const b = arr[randInt(this.rng, arr.length)]!;
        free.delete(b);
        blocks.push({ blocker: b, attacker: a.id });
      }
      return { type: 'AssignBlockers', blocks };
    }

    const hp = this.v.players[this.me]!.labHP;
    const dmgOf = (a: (typeof attacks)[number]) => Math.max(0, this.fighterStrength(a.units, true).physical);
    const sorted = [...attacks].sort((x, y) => dmgOf(y) - dmgOf(x));
    const chosen = new Map<string, string>();
    // 1) Good blocks: likely to survive and/or kill the attacker.
    for (const a of sorted) {
      let best: { b: string; score: number } | null = null;
      const sa = this.fighterStrength(a.units, true);
      const attVal = a.units.reduce((s, u) => s + this.unitValue(u), 0);
      for (const b of free) {
        const bu = this.fighter(b);
        const o = odds(this.rules, this.v.config.diceVariant, sa, this.fighterStrength(bu, false));
        if (blk.forbidden?.some((f) => f.attacker === a.id && f.blocker === b)) continue;
        const bVal = bu.reduce((s, u) => s + this.unitValue(u), 0);
        // Carrion Foundress feeds on what it kills: expensive blockers are a bigger risk.
        const feeds = a.units.some((u) => this.def(u).effects.some((e) => e.effect === 'Feeding'));
        const feedRisk = feeds ? o.defDestroyed * bu.reduce((s, u) => s + this.costSize(this.def(u)), 0) * 0.8 : 0;
        const score = o.attDestroyed * attVal - o.defDestroyed * bVal - feedRisk + dmgOf(a) * (hp <= 8 ? 0.6 : 0.3);
        if (score > (best?.score ?? 0.4) && o.defDestroyed < (this.level === 'hard' ? 0.6 : 0.5)) best = { b, score };
      }
      if (best) {
        chosen.set(a.id, best.b);
        free.delete(best.b);
      }
    }
    // 2) Prevent lethal: chump-block the biggest remaining hits until we survive.
    let incoming = sorted.filter((a) => !chosen.has(a.id)).reduce((s, a) => s + dmgOf(a), 0);
    for (const a of sorted) {
      if (incoming < hp) break;
      if (chosen.has(a.id) || !free.size) continue;
      const legal = [...free].filter((b) => !blk.forbidden?.some((f) => f.attacker === a.id && f.blocker === b));
      if (!legal.length) continue;
      const cheapest = legal.sort((x, y) => this.unitValue(x) - this.unitValue(y))[0]!;
      chosen.set(a.id, cheapest);
      free.delete(cheapest);
      incoming -= dmgOf(a);
    }
    for (const [attacker, blocker] of chosen) blocks.push({ attacker, blocker });
    return { type: 'AssignBlockers', blocks };
  }

  // ---------- priority windows ----------

  private priority(): Command {
    const la = this.la;
    const react = this.reactive();
    if (react) return react;
    if (!la.plays.length) return { type: 'Pass' };
    const info = (la.prompt.info ?? {}) as { point?: string; stack?: { controller: number; target: string | null }[] };
    if (this.level === 'easy') {
      if (this.rand() < 0.25) {
        const p = la.plays[randInt(this.rng, la.plays.length)]!;
        return this.playCmd(p.uid, p.targets ? p.targets[randInt(this.rng, p.targets.length)]! : null, p.suggested);
      }
      return { type: 'Pass' };
    }
    const battle = this.v.battle;
    const pending = (battle?.attacks ?? []).filter((a) => a.status === 'pending');
    const iAmDefender = pending.some((a) => a.target === this.me);
    const iAmAttacker = battle?.attacker === this.me;
    // Don't fight over our own card on the stack.
    const top = info.stack?.[info.stack.length - 1];
    if (top && top.controller === this.me) return { type: 'Pass' };

    for (const p of la.plays) {
      const d = this.v.defs[p.cardId]!;
      if (isTrapLike(d) && p.targets) {
        let best: { uid: string; score: number } | null = null;
        for (const t of p.targets) {
          let score = this.unitValue(t);
          const inAttack = pending.find((a) => a.units.includes(t));
          if (iAmDefender && inAttack && inAttack.target === this.me) score += Math.max(0, this.fighterStrength(inAttack.units, true).physical) * 1.5 + 2;
          const asBlocker = pending.find((a) => a.blockers.includes(t));
          if (iAmAttacker && asBlocker) score += 3;
          if (top && top.target && this.v.cards[top.target]?.owner === this.me && t !== top.target) score += 1; // trade back
          if (!best || score > best.score) best = { uid: t, score };
        }
        const threshold = this.level === 'hard' ? (info.point === 'battlePower' || info.point === 'afterAttackersDeclared' ? 5 : 9) : 6;
        if (best && best.score >= threshold) return this.playCmd(p.uid, best.uid, this.pickPayment(p.payments, p.suggested));
      }
      if (d.cardType === 'Power' && info.point === 'battlePower') {
        const e = d.effects.find((x) => x.trigger === 'OnPlay');
        // v0.4 combat Pulses: pump an engaged unit, cannibalize for a burst, jam, disable or ping.
        if (e && ['PowerRoll', 'StackBuff', 'CannibalInstinct', 'DamageTargets', 'DisableTargets', 'SignalJam', 'DepleteUnit'].includes(e.effect) && pending.length) {
          const pick = this.powerPick(d, p.targets);
          if (pick.score >= 3 && pick.target) return this.playCmd(p.uid, pick.target, this.pickPayment(p.payments, p.suggested));
        }
        if (e?.effect === 'DisableUnits' && pending.length) {
          const hits = (uids: string[]) => uids.filter((u) => this.disableHits(e.params.filter, u)).reduce((s, u) => s + this.unitValue(u), 0);
          const theirs = pending.flatMap((a) => (a.seat === this.me ? a.blockers : a.units));
          const mine = pending.flatMap((a) => (a.seat === this.me ? a.units : a.blockers));
          if (hits(theirs) - hits(mine) > 3) return this.playCmd(p.uid, null, p.suggested);
        }
        if (e?.effect === 'DealDamage' || e?.effect === 'DamageAll') {
          const pick = this.powerPick(d, p.targets);
          if (pick.score >= 6) return this.playCmd(p.uid, pick.target, this.pickPayment(p.payments, p.suggested));
        }
        if (e?.effect === 'ReviveToLab' && this.powerScore(d) > 8) return this.playCmd(p.uid, null, p.suggested);
        if (e?.effect === 'ReturnFromDiscard' || e?.effect === 'SearchDeck') {
          if (this.powerScore(d) > 4) return this.playCmd(p.uid, null, p.suggested);
        }
      }
    }
    return { type: 'Pass' };
  }

  // ---------- small decisions ----------

  private chooseCard(): string | null {
    const p = this.la.prompt;
    const opts = (p.options ?? []).filter((o): o is string => o !== null);
    const info = (p.info ?? {}) as { byCardId?: boolean; reveal?: boolean; optional?: boolean };
    if (!opts.length) return null;
    if (this.level === 'easy') return opts[0]!;
    if (info.byCardId) {
      // Creation Oracle: the CU type our hand is shortest of.
      const need: Record<string, number> = {};
      const have = this.readyCUs();
      for (const u of this.v.players[this.me]!.hand ?? []) {
        const c = this.def(u).cost;
        if (c) for (const t of CU_TYPES) need[t] = (need[t] ?? 0) + c[t];
      }
      const typeOf = (id: string) => this.v.defs[id]?.cuType as CUType;
      return [...opts].sort((a, b) => (need[typeOf(b)] ?? 0) - have[typeOf(b)] - ((need[typeOf(a)] ?? 0) - have[typeOf(a)]))[0]!;
    }
    const value = (uid: string) => this.cardStaticValue(this.def(uid));
    if ((info as { pickLow?: boolean }).pickLow) {
      // Costs (Cannibalize, discards, removal): give up the least valuable card — or decline if optional.
      const low = [...opts].sort((a, b) => value(a) - value(b))[0]!;
      if (info.optional && value(low) > 6) return null;
      return low;
    }
    if (info.reveal) return [...opts].sort((a, b) => value(a) - value(b))[0]!; // show the least useful
    return [...opts].sort((a, b) => value(b) - value(a))[0]!;
  }

  private battleOrder(): string | null {
    const opts = (this.la.prompt.options ?? []).filter((o): o is string => o !== null);
    // Commanders fight last so their auras help every earlier battle.
    const hasCommander = (id: string) => (this.v.battle?.attacks.find((a) => a.id === id)?.units ?? []).some((u) => this.def(u).isCommander);
    return [...opts].sort((a, b) => Number(hasCommander(a)) - Number(hasCommander(b)))[0] ?? null;
  }

  /** Generic decisions: the engine attaches public-information scores; add a little noise. */
  private decideToken(): string | null {
    const p = this.la.prompt;
    const info = (p.info ?? {}) as { scores?: Record<string, number>; noneScore?: number };
    const opts = (p.options ?? []).filter((o): o is string => o !== null);
    const allowNone = (p.options ?? []).includes(null);
    if (!opts.length) return null;
    const noise = this.level === 'easy' ? 2 : this.level === 'normal' ? 0.4 : 0.1;
    let best: string | null = allowNone ? null : opts[0]!;
    let bestScore = allowNone ? (info.noneScore ?? 0) + (this.rand() - 0.5) * noise : -Infinity;
    for (const o of opts) {
      const sc = (info.scores?.[o] ?? 0) + (this.rand() - 0.5) * noise;
      if (sc > bestScore) {
        best = o;
        bestScore = sc;
      }
    }
    return best;
  }

  /** Creation-phase activated abilities worth using. */
  private mainActivation(): Command | null {
    const me = this.v.players[this.me]!;
    for (const a of this.la.activations ?? []) {
      if (a.ability === 'FabricatorDiscount' && (me.hand ?? []).some((u) => this.def(u).cardType === 'Equipment')) {
        // Depleting it costs its attack and its block this round: only worth it when we can spare the body.
        const ready = this.opponents().flatMap((o) => this.v.players[o]!.lab.filter((u) => !this.v.cards[u]!.depleted));
        const incoming = ready.reduce((n, u) => n + this.strength(u, true).physical, 0);
        const blockers = me.lab.filter((u) => u !== a.uid && !this.v.cards[u]!.depleted).length;
        // Safe when the other blockers cover every ready attacker, or the possible Lab damage is small.
        if (this.level === 'easy' || blockers >= ready.length || incoming <= Math.min(2, me.labHP - 1)) return { type: 'Activate', uid: a.uid, ability: a.ability };
      }
      if (a.ability === 'HarvestScrap' && (me.hand ?? []).length <= 4 && this.level !== 'easy') return { type: 'Activate', uid: a.uid, ability: a.ability };
    }
    return null;
  }

  /** Reactions: intercept an unblocked attacker, counter / soften Powers aimed at our units. */
  private reactive(): Command | null {
    const la = this.la;
    const info = (la.prompt.info ?? {}) as { point?: string; stack?: { controller: number; target: string | null }[] };
    for (const a of la.activations ?? []) {
      if (a.ability !== 'Intercept') continue;
      const atk = (this.v.battle?.attacks ?? []).filter((x) => x.status === 'pending' && x.target === this.me && !x.blockers.length);
      const dmg = atk.reduce((s, x) => s + this.fighterStrength(x.units, true).physical, 0);
      if (dmg >= 3 || dmg >= this.v.players[this.me]!.labHP) return { type: 'Activate', uid: a.uid, ability: a.ability };
    }
    const top = info.stack?.[info.stack.length - 1];
    if (!top || top.controller === this.me) return null;
    for (const p of la.plays) {
      const d = this.v.defs[p.cardId]!;
      const e = d.effects.find((x) => x.trigger === 'OnPlay');
      if (!e || !p.targets?.length) continue;
      if (e.effect === 'CounterPulse' || e.effect === 'Molting') return this.playCmd(p.uid, p.targets[0]!, this.pickPayment(p.payments, p.suggested));
      if (e.effect === 'PreventDamage' && top.target && p.targets.includes(top.target)) return this.playCmd(p.uid, top.target, this.pickPayment(p.payments, p.suggested));
    }
    return null;
  }

  private optionalRoll(): boolean {
    const uid = (this.la.prompt.info as { uid?: string } | undefined)?.uid;
    if (!uid) return true;
    const e = this.def(uid).effects.find((x) => x.trigger === 'ModifyRoll' || x.trigger === 'CyborgStep');
    if (!e) return true;
    if (e.trigger === 'CyborgStep') return true; // no downside
    const table = e.params.bySide as Record<string, number> | undefined;
    if (!table) return true;
    const ev = Object.values(table).reduce((s, x) => s + x, 0) / 6;
    if (this.level === 'easy') return true;
    return ev >= 0;
  }

  private reroll(): boolean {
    const info = (this.la.prompt.info ?? {}) as { yourTotal?: number; theirTotal?: number; yourDie?: number };
    const mine = info.yourTotal ?? 0;
    const theirs = info.theirTotal ?? 0;
    if (this.level !== 'hard') return mine <= theirs;
    // Hard: re-roll iff a fresh Physical die is more likely to win than the current result.
    const table = this.rules.dice[this.v.config.diceVariant].physical;
    const cur = table[String(info.yourDie ?? 1)]!;
    const base = mine - (cur.bonus ?? 0);
    const sides = [1, 2, 3, 4, 5, 6];
    const pWin = sides.filter((s) => base + table[String(s)]!.bonus > theirs).length / 6;
    const nowWins = mine > theirs ? 1 : 0;
    return pWin > nowWins;
  }
}

/** Pick a command for the seat holding `legal.prompt`, from its filtered view only. */
export function chooseCommand(level: AiLevel, view: GameView, legal: LegalView, rules: RulesData, rng: RngState): Command {
  return new Brain(level, view, legal, rules, rng).decide();
}

/** v0.4: containment Powers behave like the old Trap cards for the AI. */
function isTrapLike(d: CardDef): boolean {
  return d.cardType === 'Trap' || d.effects.some((e) => e.trigger === 'OnPlay' && (e.effect === 'TrapUnit' || e.effect === 'Restrict'));
}
