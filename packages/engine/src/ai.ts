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
    for (const t of CU_TYPES) r[t] -= d.cost[t];
    let spare = 0;
    for (const t of CU_TYPES) {
      if (r[t] < 0) return false;
      spare += r[t];
    }
    spare -= d.cost.W;
    const need = CU_TYPES.reduce((n, t) => n + reserve.cost![t], 0) + reserve.cost.W;
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
    }
  }

  // ---------- Creation phase ----------

  private main(): Command {
    const la = this.la;
    if (this.level === 'easy') {
      const units = la.plays.filter((p) => this.v.defs[p.cardId]!.cardType === 'BattleUnit');
      if (units.length) {
        const best = units.sort((a, b) => this.costSize(this.v.defs[b.cardId]!) - this.costSize(this.v.defs[a.cardId]!))[0]!;
        return this.playCmd(best.uid, null, best.suggested);
      }
      const other = la.plays.filter((p) => this.v.defs[p.cardId]!.cardType !== 'Trap');
      if (other.length && this.rand() < 0.35) {
        const p = other[randInt(this.rng, other.length)]!;
        return this.playCmd(p.uid, p.targets ? p.targets[randInt(this.rng, p.targets.length)]! : null, p.suggested);
      }
      return { type: 'AdvancePhase' };
    }

    // Normal / Hard: keep CUs back for an instant if we hold one.
    const hand = this.v.players[this.me]!.hand ?? [];
    const reserve = hand.map((u) => this.def(u)).filter((d) => d.cardType === 'Trap' || d.effects.some((e) => e.effect === 'DisableUnits')).sort((a, b) => this.costSize(a) - this.costSize(b))[0] ?? null;

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
      } else if (d.cardType === 'Power') {
        const pick = this.powerPick(d, p.targets);
        score = pick.score;
        target = pick.target;
      }
      else if (d.cardType === 'Trap' && p.targets) {
        // Hard holds Traps for the opponent's attack; Normal traps a big threat now.
        const t = this.bestTrapTarget(p.targets);
        if (t && (this.level === 'normal' ? t.value >= 5 : t.value >= 8)) {
          score = 4 + t.value;
          target = t.uid;
        }
      }
      if (score === -Infinity) continue;
      if (d !== reserve && d.cardType !== 'Resource' && !this.leavesReserve(d, reserve)) score -= 8;
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

  private attack(): Command {
    const la = this.la;
    const att = la.attack!;
    const targets = att.targets;
    // Prefer the weakest opponent (lowest HP) — sensible in free-for-all too.
    const target = [...targets].sort((a, b) => this.v.players[a]!.labHP - this.v.players[b]!.labHP)[0]!;
    const blockersOf = (seat: Seat) => this.v.players[seat]!.lab.filter((u, i, arr) => {
      const c = this.v.cards[u]!;
      if (c.stackPartner && arr.indexOf(c.stackPartner) < i) return false;
      return !this.disabled(u);
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
      for (const [u, ev] of evs) if (ev < worstEv) { worstEv = ev; worst = u; }
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
    return this.v.turnEffects.some((te) => te.kind === 'disable' && this.disableHits(te.filter, uid));
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
        const arr = [...free];
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
        const bVal = bu.reduce((s, u) => s + this.unitValue(u), 0);
        const score = o.attDestroyed * attVal - o.defDestroyed * bVal + dmgOf(a) * (hp <= 8 ? 0.6 : 0.3);
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
      const cheapest = [...free].sort((x, y) => this.unitValue(x) - this.unitValue(y))[0]!;
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
      if (d.cardType === 'Trap' && p.targets) {
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
    if (info.reveal) return [...opts].sort((a, b) => value(a) - value(b))[0]!; // show the least useful
    return [...opts].sort((a, b) => value(b) - value(a))[0]!;
  }

  private battleOrder(): string | null {
    const opts = (this.la.prompt.options ?? []).filter((o): o is string => o !== null);
    // Commanders fight last so their auras help every earlier battle.
    const hasCommander = (id: string) => (this.v.battle?.attacks.find((a) => a.id === id)?.units ?? []).some((u) => this.def(u).isCommander);
    return [...opts].sort((a, b) => Number(hasCommander(a)) - Number(hasCommander(b)))[0] ?? null;
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
