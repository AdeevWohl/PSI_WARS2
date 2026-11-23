/**
 * Interaction controller: maps the current prompt + clicks to commands. Only legal actions
 * highlight; everything it sends comes from the engine's legal-action list, and the engine
 * re-validates anyway.
 */
import type { Command, Seat } from '@psi-wars/shared';
import { defaultCommandFor, type GameView, type LegalView, type PlayOption } from '@psi-wars/engine';
import type { CardCtx } from '../render/board';
import { settings } from '../settings';
import { h, toast } from './dom';
import { openModal, pickPayment, promptModal, type ModalHandle } from './modals';

type Mode =
  | { k: 'none' }
  | { k: 'target'; play: PlayOption }
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
}

export class Controller {
  view: GameView | null = null;
  legal: LegalView | null = null;
  private mode: Mode = { k: 'none' };
  private attackSel = new Map<string, Seat>();
  private blockSel = new Map<string, string>();
  private pendingBlocker: string | null = null;
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
    this.modal?.close();
    this.modal = null;
    this.closePopover();
  }

  dispose(): void {
    this.reset();
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
      if (m.play.targets?.includes(ctx.uid) && (ctx.zone === 'lab' || ctx.zone === 'battle')) el.classList.add('target', 'interactive');
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
        if ([...this.attackSel.keys()].some((u) => this.sameFighter(u, ctx.uid))) el.classList.add('selected', 'attacking-pick');
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
        this.mode = { k: 'target', play };
        this.rerender();
        return;
      }
      return this.play(play, undefined);
    }

    if (m.k === 'target') {
      if (m.play.targets?.includes(ctx.uid)) return this.play(m.play, ctx.uid);
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
      if (existing) this.attackSel.delete(existing);
      else this.attackSel.set(rep, la.attack!.targets[0]!);
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
    if (play.payments.length > 1) {
      const chosen = await pickPayment(this.host, def, play.payments, play.suggested);
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

  async drop(ctx: CardCtx, targetUid: string | null): Promise<void> {
    const la = this.legal;
    if (!la) return;
    const k = la.prompt.kind;
    if (ctx.zone === 'hand') {
      const play = la.plays.find((p) => p.uid === ctx.uid);
      if (!play) return;
      if (play.targets && (!targetUid || !play.targets.includes(targetUid))) return;
      return this.play(play, targetUid ?? undefined);
    }
    if (ctx.zone === 'equip' && targetUid) return this.send({ type: 'MoveEquipment', equip: ctx.uid, to: targetUid });
    const pair = targetUid ? la.stacks.find((p) => (p.a === ctx.uid && p.b === targetUid) || (p.b === ctx.uid && p.a === targetUid)) : undefined;
    if (pair) return this.send({ type: 'Stack', a: pair.a, b: pair.b });
    if (k === 'declareAttackers' && !targetUid) {
      const rep = la.attack!.eligible.find((e) => this.sameFighter(e, ctx.uid));
      if (rep && ![...this.attackSel.keys()].some((u) => this.sameFighter(u, rep))) this.attackSel.set(rep, la.attack!.targets[0]!);
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
    if (m.k === 'target') return `Choose a target for ${this.view!.defs[m.play.cardId]!.name}. Esc to cancel.`;
    if (m.k === 'moveEquip') return 'Choose the unit to move the Equipment to.';
    if (m.k === 'stack') return m.first ? 'Choose the unit to stack with (one Cyborg + one non-Cyborg).' : 'Click a unit to stack, or a stack to split it.';
    const info = (la.prompt.info ?? {}) as any;
    switch (la.prompt.kind) {
      case 'main':
        return la.plays.length ? 'Play cards from your hand, manage Equipment, then go to Battle.' : 'Nothing affordable to play. Go to Battle when ready.';
      case 'declareAttackers':
        return 'Click ready units to attack. A stack attacks as one.';
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
    switch (la.prompt.kind) {
      case 'main':
        if (m.k === 'none') out.push({ label: 'Go to Battle', primary: true, key: 'Space', onClick: () => this.confirmAdvance() });
        break;
      case 'declareAttackers': {
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
