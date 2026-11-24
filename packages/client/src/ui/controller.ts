/**
 * Interaction controller: maps the current prompt + clicks to commands. Only legal actions
 * highlight; everything it sends comes from the engine's legal-action list, and the engine
 * re-validates anyway.
 */
import type { Command, Seat } from '@psi-wars/shared';
import { aimStyle } from '../anim/spell-fx';
import { defaultCommandFor, type GameView, type LegalView, type PlayOption } from '@psi-wars/engine';
import type { CardCtx } from '../render/board';
import { settings } from '../settings';
import { h, toast } from './dom';
import { openModal, pickPayment, promptModal, type ModalHandle } from './modals';

type Mode =
  | { k: 'none' }
  | { k: 'target'; play: PlayOption; staged?: boolean; chosen?: string | null }
  | { k: 'moveEquip'; equip: string; to: string[] }
  | { k: 'stack'; first: string | null };

/** What a card can be dragged to: specific cards, or a zone. */
export interface DragSpec {
  targets?: string[];
  zone?: 'board' | 'battlefield';
}

export interface ActionButton {
  label: string;
  onClick: () => void;
  primary?: boolean;
  danger?: boolean;
  key?: string;
  disabled?: boolean;
  /** Seat colour for opponent-target chips. */
  color?: string;
  active?: boolean;
}

const SEAT_COLORS = ['#4fd1ff', '#ff8a4c', '#c77dff', '#5ee6a8'];

export class Controller {
  view: GameView | null = null;
  legal: LegalView | null = null;
  private mode: Mode = { k: 'none' };
  private attackSel = new Map<string, Seat>();
  private blockSel = new Map<string, string>();
  private pendingBlocker: string | null = null;
  /** 3–4 players: the opponent newly picked attackers go after (house rule A). */
  private attackTarget: Seat | null = null;
  private promptKey = '';
  private modal: ModalHandle | null = null;
  private popover: HTMLElement | null = null;
  /** Commands are queued, never dropped: input stays responsive while one is in flight (§6.1). */
  private queue: Promise<void> = Promise.resolve();
  /** Prompt key that already has an answer queued — guards against double-clicks. */
  private answeredKey = '';

  constructor(
    private host: HTMLElement,
    private sendCmd: (cmd: Command) => Promise<boolean>,
    private rerender: () => void,
    private names: (s: unknown) => string,
  ) {}

  get seat(): Seat | null {
    return this.legal?.seat ?? null;
  }

  sync(view: GameView, legal: LegalView | null): void {
    this.view = view;
    this.legal = legal;
    const key = legal ? `${view.commandCount}:${legal.prompt.kind}:${legal.seat}` : `none:${view.commandCount}`;
    if (key !== this.promptKey) {
      this.promptKey = key;
      this.reset();
      if (legal) this.modal = promptModal(this.host, view, legal, (choice) => this.answerModal(choice), this.names);
    }
  }

  private reset(): void {
    this.mode = { k: 'none' };
    this.attackSel.clear();
    this.blockSel.clear();
    this.pendingBlocker = null;
    this.attackTarget = null;
    this.modal?.close();
    this.modal = null;
    this.closePopover();
  }

  dispose(): void {
    this.reset();
  }

  /** Current target for new attackers: the chosen one, else the next opponent in turn order. */
  private currentTarget(): Seat {
    const la = this.legal!;
    const targets = la.attack?.targets ?? [];
    if (this.attackTarget !== null && targets.includes(this.attackTarget)) return this.attackTarget;
    const n = this.view?.players.length ?? 2;
    for (let i = 1; i <= n; i++) {
      const s = (la.seat + i) % n;
      if (targets.includes(s)) return s;
    }
    return targets[0]!;
  }

  tentativeBlocks(): Map<string, string> {
    return this.legal?.prompt.kind === 'declareBlockers' ? this.blockSel : new Map();
  }

  private send(cmd: Command): Promise<void> {
    const answers = ['DeclareAttackers', 'AssignBlockers', 'Pass', 'AdvancePhase', 'ChooseFromList', 'UseAbility', 'ChooseReroll'];
    if (answers.includes(cmd.type)) {
      if (this.answeredKey === this.promptKey) return this.queue;
      this.answeredKey = this.promptKey;
    }
    this.queue = this.queue.then(async () => {
      try {
        const ok = await this.sendCmd(cmd);
        if (!ok) {
          this.answeredKey = '';
          this.rerender();
        }
      } catch {
        this.answeredKey = '';
        this.rerender();
      }
    });
    return this.queue;
  }

  /** v0.4 activated abilities (Fabricator Drone, Scrap Harvester, Suture Architect, Loquidor Stalker). */
  activate(uid: string, ability: string): void {
    void this.send({ type: 'Activate', uid, ability });
  }

  private answerModal(choice: unknown): void {
    const p = this.legal?.prompt;
    if (!p) return;
    this.modal = null;
    if (p.kind === 'optionalRoll') void this.send({ type: 'UseAbility', use: !!choice });
    else if (p.kind === 'reroll') void this.send({ type: 'ChooseReroll', reroll: !!choice });
    else void this.send({ type: 'ChooseFromList', choice: choice as string | null });
  }

  // ---------- decoration ----------

  private sameFighter(a: string, b: string): boolean {
    return a === b || this.view?.cards[a]?.stackPartner === b;
  }

  decorate(el: HTMLElement, ctx: CardCtx): void {
    const la = this.legal;
    const v = this.view!;
    el.removeAttribute('title');
    if (!la) {
      if (ctx.zone === 'hand') el.classList.add('interactive');
      return;
    }
    const k = la.prompt.kind;
    const mine = ctx.owner === la.seat;
    const m = this.mode;

    if (ctx.zone === 'hand' && mine) {
      const play = la.plays.find((p) => p.uid === ctx.uid);
      if (m.k === 'target' && m.play.uid === ctx.uid) el.classList.add('selected', 'interactive');
      else if (play && m.k === 'none') el.classList.add('interactive', 'selectable');
      else {
        el.classList.add('dimmed');
        const why = la.unplayable[ctx.uid];
        if (why) el.title = why;
        el.classList.add('interactive');
      }
      return;
    }

    if (m.k === 'target') {
      if (m.play.targets?.includes(ctx.uid) && (ctx.zone === 'lab' || ctx.zone === 'battle')) {
        el.classList.add('target', 'interactive');
        if (m.staged) {
          // Each spell aims in its own style (Overload Strike: red lightning; Grankor: frost; others: a gold mark).
          el.classList.add(`aim-${aimStyle(m.play.cardId)}`, m.chosen === ctx.uid ? 'aim-locked' : m.chosen ? 'aim-off' : 'aim');
        }
      }
      return;
    }
    if (m.k === 'moveEquip') {
      if (m.to.includes(ctx.uid)) el.classList.add('target', 'interactive');
      if (ctx.uid === m.equip) el.classList.add('selected');
      return;
    }
    if (m.k === 'stack' && mine && (ctx.zone === 'lab' || ctx.zone === 'battle')) {
      const pairs = la.stacks;
      if (m.first === ctx.uid) el.classList.add('selected', 'interactive');
      else if (m.first) {
        if (pairs.some((p) => (p.a === m.first && p.b === ctx.uid) || (p.b === m.first && p.a === ctx.uid))) el.classList.add('target', 'interactive');
      } else if (pairs.some((p) => p.a === ctx.uid || p.b === ctx.uid) || la.unstacks.some((u) => this.sameFighter(u, ctx.uid))) el.classList.add('selectable', 'interactive');
      return;
    }

    if (ctx.zone === 'equip' && mine && (la.moveEquipment.some((x) => x.equip === ctx.uid) || la.discardEquipment.includes(ctx.uid))) {
      el.classList.add('interactive', 'selectable');
      el.title = 'Move or discard this Equipment';
      return;
    }

    if (k === 'declareAttackers' && mine && ctx.zone === 'lab') {
      const rep = la.attack!.eligible.find((e) => this.sameFighter(e, ctx.uid));
      if (rep) {
        el.classList.add('interactive', 'selectable');
        const picked = [...this.attackSel.entries()].find(([u]) => this.sameFighter(u, ctx.uid));
        if (picked) {
          el.classList.add('selected', 'attacking-pick');
          el.style.setProperty('--target-color', SEAT_COLORS[picked[1]] ?? '#ff4a4a');
          if (la.attack!.targets.length > 1) {
            const tag = h('span', { class: 'target-tag' }, `→ ${this.names(picked[1])}`);
            el.querySelector('.overlays')?.appendChild(tag);
          }
        } else el.style.removeProperty('--target-color');
      }
      return;
    }
    if (k === 'declareBlockers') {
      if (mine && (ctx.zone === 'lab' || ctx.zone === 'battle')) {
        const rep = la.block!.blockers.find((e) => this.sameFighter(e, ctx.uid));
        if (rep) {
          el.classList.add('interactive', 'selectable');
          if (this.pendingBlocker && this.sameFighter(this.pendingBlocker, ctx.uid)) el.classList.add('selected');
        }
      } else if (!mine && ctx.zone === 'battle' && ctx.attackId && la.block!.attackers.includes(ctx.attackId) && v.battle?.attacks.find((a) => a.id === ctx.attackId)?.units.includes(ctx.uid)) {
        el.classList.add('interactive');
        if (this.pendingBlocker) el.classList.add('target');
      }
    }
  }

  // ---------- clicks ----------

  async click(ctx: CardCtx, ev: MouseEvent): Promise<void> {
    const la = this.legal;
    if (!la) return;
    const m = this.mode;
    const mine = ctx.owner === la.seat;

    if (ctx.zone === 'hand' && mine) {
      if (m.k === 'target' && m.play.uid === ctx.uid) return this.cancel();
      const play = la.plays.find((p) => p.uid === ctx.uid);
      if (!play) {
        toast(la.unplayable[ctx.uid] ?? 'Not playable now', 'warn');
        return;
      }
      if (play.targets) {
        this.mode = { k: 'target', play, staged: this.isSpell(play), chosen: null };
        this.rerender();
        return;
      }
      return this.play(play, undefined);
    }

    if (m.k === 'target') {
      if (m.play.targets?.includes(ctx.uid)) {
        if (m.staged) return this.chooseTarget(ctx.uid);
        return this.play(m.play, ctx.uid);
      }
      return;
    }
    if (m.k === 'moveEquip') {
      if (m.to.includes(ctx.uid)) {
        this.mode = { k: 'none' };
        return this.send({ type: 'MoveEquipment', equip: m.equip, to: ctx.uid });
      }
      return;
    }
    if (m.k === 'stack' && mine) {
      const unstack = la.unstacks.find((u) => this.sameFighter(u, ctx.uid));
      if (!m.first && unstack) {
        this.mode = { k: 'none' };
        return this.send({ type: 'Unstack', uid: unstack });
      }
      if (!m.first) {
        if (la.stacks.some((p) => p.a === ctx.uid || p.b === ctx.uid)) {
          this.mode = { k: 'stack', first: ctx.uid };
          this.rerender();
        }
        return;
      }
      const pair = la.stacks.find((p) => (p.a === m.first && p.b === ctx.uid) || (p.b === m.first && p.a === ctx.uid));
      if (pair) {
        this.mode = { k: 'none' };
        return this.send({ type: 'Stack', a: pair.a, b: pair.b });
      }
      if (ctx.uid === m.first) this.mode = { k: 'stack', first: null };
      this.rerender();
      return;
    }

    if (ctx.zone === 'equip' && mine) {
      const mv = la.moveEquipment.find((x) => x.equip === ctx.uid);
      const canDiscard = la.discardEquipment.includes(ctx.uid);
      if (mv || canDiscard) this.openEquipMenu(ev, ctx.uid, mv?.to ?? null, canDiscard);
      return;
    }

    const k = la.prompt.kind;
    if (k === 'declareAttackers' && mine) {
      const rep = la.attack!.eligible.find((e) => this.sameFighter(e, ctx.uid));
      if (!rep) return;
      const existing = [...this.attackSel.keys()].find((u) => this.sameFighter(u, rep));
      const target = this.currentTarget();
      // Clicking a picked attacker sends it at the currently chosen opponent; clicking again un-picks it.
      if (existing && this.attackSel.get(existing) !== target) this.attackSel.set(existing, target);
      else if (existing) this.attackSel.delete(existing);
      else this.attackSel.set(rep, target);
      this.rerender();
      return;
    }
    if (k === 'declareBlockers') {
      if (mine) {
        const rep = la.block!.blockers.find((e) => this.sameFighter(e, ctx.uid));
        if (!rep) return;
        // Clicking an assigned blocker un-assigns it.
        for (const [a, b] of this.blockSel) if (this.sameFighter(b, rep)) {
          this.blockSel.delete(a);
          this.pendingBlocker = null;
          this.rerender();
          return;
        }
        this.pendingBlocker = this.pendingBlocker && this.sameFighter(this.pendingBlocker, rep) ? null : rep;
        if (this.pendingBlocker && la.block!.attackers.length === 1) {
          this.blockSel.set(la.block!.attackers[0]!, this.pendingBlocker);
          this.pendingBlocker = null;
        }
        this.rerender();
        return;
      }
      if (ctx.attackId && la.block!.attackers.includes(ctx.attackId) && this.pendingBlocker) {
        this.blockSel.set(ctx.attackId, this.pendingBlocker);
        this.pendingBlocker = null;
        this.rerender();
      }
    }
  }

  private async play(play: PlayOption, target: string | undefined): Promise<void> {
    const v = this.view!;
    const def = v.defs[play.cardId]!;
    let payment = play.suggested ?? undefined;
    // Real choices: more than one way to pay, or a Fortified Creation Unit that could be burned.
    const me = (this.legal?.seat ?? v.prompt?.seat ?? 0) as number;
    const cost = play.cost ?? def.cost;
    const fortChoice = !!cost && (cost.W > 0 || (cost.burns?.length ?? 0) > 0) && (v.players[me]?.cus ?? []).some((u) => { const eq = v.cards[u]?.equipment; return !!eq && !v.cards[u]!.depleted && v.defs[v.cards[eq]?.cardId ?? '']?.effects.some((e) => e.effect === 'FortifyResource'); });
    if (cost && (play.payments.length > 1 || fortChoice)) {
      const chosen = await pickPayment(this.host, v, me, def, cost, play.suggested);
      if (!chosen) {
        this.cancel();
        return;
      }
      payment = chosen;
    }
    this.mode = { k: 'none' };
    await this.send({ type: 'PlayCard', uid: play.uid, ...(target ? { target } : {}), ...(payment ? { payment } : {}) });
  }

  private openEquipMenu(ev: MouseEvent, equip: string, to: string[] | null, canDiscard: boolean): void {
    this.closePopover();
    const stageRect = this.host.getBoundingClientRect();
    const scale = stageRect.width / 1920;
    const pop = h(
      'div',
      { class: 'popover panel', role: 'menu' },
      to ? h('button', { class: 'btn small', role: 'menuitem', onclick: () => { this.closePopover(); this.mode = { k: 'moveEquip', equip, to }; this.rerender(); } }, 'Move to another unit…') : null,
      canDiscard ? h('button', { class: 'btn small danger', role: 'menuitem', onclick: () => { this.closePopover(); void this.send({ type: 'DiscardEquipment', equip }); } }, 'Discard') : null,
      h('button', { class: 'btn small ghost', role: 'menuitem', onclick: () => this.closePopover() }, 'Cancel'),
    );
    pop.style.left = `${(ev.clientX - stageRect.left) / scale}px`;
    pop.style.top = `${(ev.clientY - stageRect.top) / scale}px`;
    this.host.appendChild(pop);
    this.popover = pop;
    (pop.querySelector('button') as HTMLElement | null)?.focus({ preventScroll: true });
  }

  private closePopover(): void {
    this.popover?.remove();
    this.popover = null;
  }

  /** Power and Trap cards with a target use the spell staging area (Confirm before casting). */
  private isSpell(play: PlayOption): boolean {
    const t = this.view?.defs[play.cardId]?.cardType;
    return t === 'Power' || t === 'Trap';
  }

  /** The staged spell, for the staging area: the card, its chosen target (if locked in). */
  staged(): { play: PlayOption; chosen: string | null } | null {
    const m = this.mode;
    return m.k === 'target' && m.staged ? { play: m.play, chosen: m.chosen ?? null } : null;
  }

  /** Lock in a target for the staged spell (a card uid or "lab:<seat>"). */
  chooseTarget(t: string): void {
    const m = this.mode;
    if (m.k !== 'target' || !m.play.targets?.includes(t)) return;
    if (!m.staged) return void this.play(m.play, t);
    this.mode = { ...m, chosen: t };
    this.rerender();
  }

  /** Back to choosing (the spell stays staged). */
  unchoose(): void {
    const m = this.mode;
    if (m.k === 'target' && m.chosen) {
      this.mode = { ...m, chosen: null };
      this.rerender();
    }
  }

  confirmSpell(): void {
    const m = this.mode;
    if (m.k === 'target' && m.staged && m.chosen) void this.play(m.play, m.chosen);
  }

  /** Dragged out of the hand: stage the spell (optionally with a target already chosen). */
  stage(ctx: CardCtx, target: string | null): boolean {
    const play = this.legal?.plays.find((p) => p.uid === ctx.uid);
    if (!play || !play.targets || !this.isSpell(play)) return false;
    this.mode = { k: 'target', play, staged: true, chosen: target && play.targets.includes(target) ? target : null };
    this.rerender();
    return true;
  }

  cancel(): void {
    this.mode = { k: 'none' };
    this.pendingBlocker = null;
    this.closePopover();
    this.rerender();
  }

  // ---------- drag-and-drop (same actions as clicking) ----------

  dragSpec(ctx: CardCtx): DragSpec | null {
    const la = this.legal;
    if (!la || ctx.owner !== la.seat || this.mode.k !== 'none') return null;
    const k = la.prompt.kind;
    if (ctx.zone === 'hand') {
      const play = la.plays.find((p) => p.uid === ctx.uid);
      if (!play) return null;
      if (play.targets && this.isSpell(play)) return { targets: play.targets, zone: 'board' };
      return play.targets ? { targets: play.targets } : { zone: 'board' };
    }
    if (ctx.zone === 'equip') {
      const mv = la.moveEquipment.find((x) => x.equip === ctx.uid);
      return mv ? { targets: mv.to } : null;
    }
    if (ctx.zone !== 'lab' && ctx.zone !== 'battle') return null;
    const partners = la.stacks.filter((p) => p.a === ctx.uid || p.b === ctx.uid).map((p) => (p.a === ctx.uid ? p.b : p.a));
    if (k === 'declareAttackers' && ctx.zone === 'lab') {
      const eligible = la.attack!.eligible.some((e) => this.sameFighter(e, ctx.uid));
      if (!eligible && !partners.length) return null;
      return { targets: partners, zone: eligible ? 'battlefield' : undefined };
    }
    if (k === 'declareBlockers') {
      const eligible = la.block!.blockers.some((e) => this.sameFighter(e, ctx.uid));
      const attackers = eligible ? (this.view?.battle?.attacks ?? []).filter((a) => la.block!.attackers.includes(a.id)).flatMap((a) => a.units) : [];
      if (!attackers.length && !partners.length) return null;
      return { targets: [...attackers, ...partners] };
    }
    return null;
  }

  async drop(ctx: CardCtx, targetUid: string | null, targetSeat?: Seat): Promise<void> {
    const la = this.legal;
    if (!la) return;
    const k = la.prompt.kind;
    if (ctx.zone === 'hand') {
      const play = la.plays.find((p) => p.uid === ctx.uid);
      if (!play) return;
      if (play.targets && this.isSpell(play)) return void this.stage(ctx, targetUid);
      if (play.targets && (!targetUid || !play.targets.includes(targetUid))) return;
      return this.play(play, targetUid ?? undefined);
    }
    if (ctx.zone === 'equip' && targetUid) return this.send({ type: 'MoveEquipment', equip: ctx.uid, to: targetUid });
    const pair = targetUid ? la.stacks.find((p) => (p.a === ctx.uid && p.b === targetUid) || (p.b === ctx.uid && p.a === targetUid)) : undefined;
    if (pair) return this.send({ type: 'Stack', a: pair.a, b: pair.b });
    if (k === 'declareAttackers' && !targetUid) {
      const rep = la.attack!.eligible.find((e) => this.sameFighter(e, ctx.uid));
      const target = targetSeat !== undefined && la.attack!.targets.includes(targetSeat) ? targetSeat : this.currentTarget();
      if (rep) {
        const existing = [...this.attackSel.keys()].find((u) => this.sameFighter(u, rep));
        this.attackSel.set(existing ?? rep, target);
      }
      this.rerender();
      return;
    }
    if (k === 'declareBlockers' && targetUid) {
      const rep = la.block!.blockers.find((e) => this.sameFighter(e, ctx.uid));
      const atk = this.view?.battle?.attacks.find((a) => a.units.includes(targetUid) && la.block!.attackers.includes(a.id));
      if (rep && atk) {
        for (const [a, b] of this.blockSel) if (this.sameFighter(b, rep)) this.blockSel.delete(a);
        this.blockSel.set(atk.id, rep);
        this.rerender();
      }
    }
  }

  // ---------- side-panel actions ----------

  hint(): string {
    const la = this.legal;
    if (!la) return '';
    const m = this.mode;
    if (m.k === 'target') {
      const ts = m.play.targets ?? [];
      const labs = ts.some((t) => t.startsWith('lab:'));
      const cus = ts.some((t) => this.view!.cards[t]?.zone === 'cus');
      const where = cus ? 'Pick one of your Creation Units below' : labs ? 'Click a glowing unit, or pick a Lab below' : 'Click a glowing unit';
      return `${where} for ${this.view!.defs[m.play.cardId]!.name}. Esc to cancel.`;
    }
    if (m.k === 'moveEquip') return 'Choose the unit to move the Equipment to.';
    if (m.k === 'stack') return m.first ? 'Choose the unit to stack with (one Cyborg + one non-Cyborg).' : 'Click a unit to stack, or a stack to split it.';
    const info = (la.prompt.info ?? {}) as any;
    switch (la.prompt.kind) {
      case 'main':
        return la.plays.length ? 'Play cards from your hand, manage Equipment, then go to Battle.' : 'Nothing affordable to play. Go to Battle when ready.';
      case 'declareAttackers':
        return la.attack!.targets.length > 1
          ? 'Pick an opponent, then click units to send them at that opponent (or drag a unit onto an opponent). Click a picked unit again to re-target or un-pick it.'
          : 'Click ready units to attack. A stack attacks as one.';
      case 'declareBlockers':
        return la.block!.attackers.length > 1 ? 'Click one of your units, then the attacker it blocks. One defender per attacker.' : 'Click a unit to block the attacker, or confirm no blocks.';
      case 'priority': {
        const stack = (info.stack ?? []) as { cardId: string; controller: number; target: string | null }[];
        const top = stack[stack.length - 1];
        if (top) {
          const tn = top.target ? this.view!.defs[this.view!.cards[top.target]?.cardId ?? '']?.name : null;
          return `${this.names(top.controller)} played ${this.view!.defs[top.cardId]?.name}${tn ? ` on ${tn}` : ''}. Respond with a Trap, or pass to let it resolve.`;
        }
        return la.prompt.allowed === 'powers' ? 'You may play Power cards and Traps, or pass.' : la.plays.length ? 'You may play a Trap now, or pass.' : 'Nothing to play — pass.';
      }
      default:
        return la.prompt.label;
    }
  }

  buttons(): ActionButton[] {
    const la = this.legal;
    if (!la) return [];
    const m = this.mode;
    const out: ActionButton[] = [];
    if (m.k !== 'none') out.push({ label: 'Cancel', onClick: () => this.cancel(), key: 'Esc' });
    // Targets that are not cards on the board: a player's Lab ("lab:<seat>") or one of your
    // Creation Units (Resource Fortification). One button each (Creation Units: one per type).
    if (m.k === 'target' && m.play.targets) {
      const v = this.view!;
      const seenCU = new Set<string>();
      for (const t of m.play.targets) {
        if (t.startsWith('lab:')) {
          const seat = Number(t.slice(4));
          out.push({ label: `→ ${this.names(seat)}'s Lab`, color: SEAT_COLORS[seat], active: m.chosen === t, onClick: () => void (m.staged ? this.chooseTarget(t) : this.play(m.play, t)) });
        } else if (v.cards[t]?.zone === 'cus') {
          const id = v.cards[t]!.cardId;
          if (seenCU.has(id)) continue;
          seenCU.add(id);
          out.push({ label: `→ ${v.defs[id]?.name ?? 'Creation Unit'}`, onClick: () => void this.play(m.play, t) });
        }
      }
    }
    switch (la.prompt.kind) {
      case 'main':
        if (m.k === 'none') out.push({ label: 'Go to Battle', primary: true, key: 'Space', onClick: () => this.confirmAdvance() });
        break;
      case 'declareAttackers': {
        if (la.attack!.targets.length > 1 && m.k === 'none') {
          const cur = this.currentTarget();
          for (const t of la.attack!.targets) out.push({ label: `→ ${this.names(t)}`, color: SEAT_COLORS[t], active: t === cur, onClick: () => { this.attackTarget = t; this.rerender(); } });
        }
        if (la.stacks.length || la.unstacks.length) out.push({ label: m.k === 'stack' ? 'Done stacking' : 'Stack units', onClick: () => { this.mode = m.k === 'stack' ? { k: 'none' } : { k: 'stack', first: null }; this.rerender(); } });
        const n = this.attackSel.size;
        if (m.k === 'none') out.push({ label: n ? `Attack with ${n}` : 'No attack', primary: true, key: 'Space', onClick: () => void this.send({ type: 'DeclareAttackers', attacks: [...this.attackSel].map(([uid, target]) => ({ uid, target })) }) });
        break;
      }
      case 'declareBlockers': {
        if (la.stacks.length || la.unstacks.length) out.push({ label: m.k === 'stack' ? 'Done stacking' : 'Stack units', onClick: () => { this.mode = m.k === 'stack' ? { k: 'none' } : { k: 'stack', first: null }; this.rerender(); } });
        const n = this.blockSel.size;
        if (m.k === 'none') out.push({ label: n ? `Confirm ${n} block${n > 1 ? 's' : ''}` : 'No blocks', primary: true, key: 'Space', onClick: () => void this.send({ type: 'AssignBlockers', blocks: [...this.blockSel].map(([attacker, blocker]) => ({ attacker, blocker })) }) });
        break;
      }
      case 'priority':
        if (m.k === 'none') out.push({ label: 'Pass', primary: true, key: 'Space', onClick: () => void this.send({ type: 'Pass' }) });
        break;
      default:
        if (!this.modal && this.view) out.push({ label: 'Decide…', primary: true, onClick: () => { this.modal = promptModal(this.host, this.view!, la, (c) => this.answerModal(c), this.names); } });
    }
    return out;
  }

  /** "Confirm before ending phase" setting: ask only when something is still playable. */
  private confirmAdvance(): void {
    const la = this.legal;
    if (!settings().confirmEndPhase || !la || la.plays.length === 0) {
      void this.send({ type: 'AdvancePhase' });
      return;
    }
    let m: ModalHandle;
    m = openModal(this.host, 'End the Creation phase?', `You can still play ${la.plays.length} card${la.plays.length > 1 ? 's' : ''}.`, null, [
      { label: 'Keep playing', onClick: () => m.close() },
      { label: 'Go to Battle', primary: true, onClick: () => { m.close(); void this.send({ type: 'AdvancePhase' }); } },
    ], { dismissable: true });
  }

  /** Default answer for the current prompt (used by the turn timer). */
  timeoutDefault(): Command | null {
    const la = this.legal;
    if (!la) return null;
    this.reset();
    return defaultCommandFor(la.prompt as any);
  }

  onKey(e: KeyboardEvent): boolean {
    if (this.modal) return false;
    if (e.key === 'Escape') {
      if (this.mode.k !== 'none' || this.popover || this.pendingBlocker) {
        this.cancel();
        return true;
      }
      return false;
    }
    if (e.key === ' ' || e.key === 'Enter') {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'BUTTON' || target.tagName === 'INPUT')) return false;
      const primary = this.buttons().find((b) => b.primary && !b.disabled);
      if (primary) {
        primary.onClick();
        return true;
      }
    }
    return false;
  }
}
