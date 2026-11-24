import type { Command, GameEvent, Seat } from '@psi-wars/shared';
import { battleOdds, chooseCommand, seedRng, type GameView, type LegalView, type RngState, type UnitStats } from '@psi-wars/engine';
import { artUrl } from '../assets';
import { Fx } from '../anim/fx';
import { Presenter, type BatchStart } from '../anim/present';
import { EASE, Timeline } from '../anim/timeline';
import { toStage } from '../anim/flip';
import { rules } from '../data';
import { Board, SEAT_COLORS, type CardCtx } from '../render/board';
import { renderBreakdown } from '../render/breakdown';
import { createCardEl, updateOverlays } from '../render/card';
import { eventLine, Namer } from '../render/log';
import { onSettings, settings, speedFactor } from '../settings';
import type { GameSource } from '../game/source';
import { Controller } from './controller';
import { DragManager } from './drag';
import { h, toast } from './dom';
import { openModal } from './modals';
import { Preview } from './preview';
import { rulesReference } from './rules';
import type { Tutorial } from './tutorial';

const PHASES = ['replenish', 'draw', 'creation', 'battle', 'cleanup'] as const;
const PHASE_LABEL = { replenish: 'Replenish', draw: 'Draw', creation: 'Create', battle: 'Battle', cleanup: 'Cleanup' };
const STEPS = ['declareAttackers', 'declareBlockers', 'power', 'cyborg', 'determination'] as const;
const STEP_LABEL: Record<string, string> = { declareAttackers: '1 · Attackers', declareBlockers: '2 · Defenders', power: '3 · Power cards', cyborg: '4 · Cyborg abilities', determination: '5 · Battle determination' };

export interface GameScreenOpts {
  onExit: () => void;
  onRematch?: () => void;
  openSettings?: (host: HTMLElement) => void;
  /** Seed for the computer players' choices (the tutorial uses a fixed one). */
  aiSeed?: string;
  /** Guided-game overlay, fed the current state after every settled render. */
  tutorial?: Tutorial;
  /** Whose perspective to draw (replays); default: the first local seat, else the public view. */
  viewer?: Seat | null;
  /** Replays: no Concede, no actions. */
  readOnly?: boolean;
}

/**
 * The game screen.
 * - Presentation: each batch of engine events is played on the animation timeline against a
 *   board already rendered in its final state (see anim/present.ts). Click or Space
 *   fast-forwards; batches queue, so input is never blocked.
 * - Hot-seat: the board is drawn for `viewer`; when a decision passes to a different local
 *   human, a curtain hides everything (after the current player has seen the results).
 */
export class GameScreen {
  readonly el: HTMLElement;
  private board: Board;
  private controller: Controller;
  private preview = new Preview();
  private namer: Namer;
  private viewer: Seat | null;
  private curtainFor: Seat | null = null;
  private turnBox = h('div', { class: 'turn-box panel' });
  private promptBox = h('div', { class: 'prompt-box panel', 'aria-live': 'polite' });
  private breakdownHost = h('div');
  private logEl = h('div', { class: 'log panel', role: 'log', 'aria-label': 'Battle log' });
  private layer = h('div', { class: 'anim-layer', 'aria-hidden': 'true' });
  private tethers = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  private events: GameEvent[] = [];
  private lastBattle: GameEvent | null = null;
  private battleShown: GameEvent | null = null;
  private logCap: number | null = null;
  private unsub: () => void;
  private unsubSettings: () => void;
  private resultsShown = false;
  private keyHandler = (e: KeyboardEvent) => this.onKey(e);
  private tl = new Timeline();
  private fx = new Fx();
  private presenter: Presenter;
  private drag: DragManager;
  private queue: GameEvent[][] = [];
  private playing = false;
  private dirty = false;
  private timer: { key: string; deadline: number; id: number; els: HTMLElement[] } | null = null;
  private aiTimer = 0;
  private aiKey = '';
  private aiRng: RngState = seedRng(`ai-${Math.random()}`);

  constructor(private source: GameSource, initialEvents: GameEvent[], private opts: GameScreenOpts) {
    this.namer = new Namer(() => this.source.view(null).defs);
    const firstLocal = source.seats.find((s) => s.kind === 'local');
    this.viewer = opts.viewer !== undefined ? opts.viewer : firstLocal?.seat ?? null;
    this.board = new Board({
      decorate: (el, ctx) => this.controller.decorate(el, ctx),
      click: (ctx, ev) => {
        if (this.drag.consumeClick()) return;
        void this.controller.click(ctx, ev);
      },
      hover: (ctx, el) => this.hover(ctx, el),
      openDiscard: (seat) => this.openDiscard(seat),
      tentativeBlocks: () => this.controller.tentativeBlocks(),
      alwaysChips: () => settings().alwaysChips,
    });
    this.tethers.classList.add('tether-layer');
    const menuBtn = h('button', { class: 'btn small ghost game-menu-btn', 'aria-label': 'Game menu', onclick: () => this.openMenu() }, '☰ Menu');
    const side = h('aside', { class: 'side' }, h('div', { class: 'side-top' }, menuBtn), this.turnBox, this.promptBox, this.breakdownHost, this.logEl);
    this.el = h('div', { class: 'game-screen' }, this.board.root, side, this.tethers, this.fx.canvas, this.layer, this.preview.el);
    const bg = artUrl('ui/menu-bg', '1920');
    if (bg) this.el.style.setProperty('--menu-bg', `url(${bg})`);
    this.controller = new Controller(this.el, (cmd) => this.send(cmd), () => this.refresh(), (s) => this.nameOf(s));
    this.drag = new DragManager(this.el, this.board, this.controller, this.tl);
    this.presenter = new Presenter({
      board: this.board,
      tl: this.tl,
      fx: this.fx,
      layer: this.layer,
      shakeEl: this.el,
      names: (s) => this.nameOf(s),
      onEvent: (i) => this.revealUpTo(i),
      onBattle: (ev) => this.showBattle(ev),
      caption: (ev) => {
        this.namer.learnEvent(ev);
        return eventLine(ev, (s) => this.nameOf(s), this.namer, this.lastView?.viewer ?? null, 'normal');
      },
    });
    if (opts.aiSeed) this.aiRng = seedRng(opts.aiSeed);
    if (opts.tutorial) this.el.append(opts.tutorial.el);
    this.events.push(...initialEvents);
    this.unsub = source.onUpdate((u) => {
      this.queue.push(u.events);
      void this.pump();
    });
    this.unsubSettings = onSettings(() => this.applyLocalSettings());
    this.applyLocalSettings();
    document.addEventListener('keydown', this.keyHandler);
    // Click anywhere fast-forwards the animation queue (capture: the click does nothing else).
    this.el.addEventListener('pointerdown', (e) => {
      if (this.playing && this.tl.busy) {
        this.tl.skip();
        e.stopPropagation();
        e.preventDefault();
      }
    }, true);
    // Hand cards tilt toward the pointer with a moving shine.
    this.el.addEventListener('pointermove', (e) => {
      const card = (e.target as Element).closest('.hand.fan .card') as HTMLElement | null;
      if (!card || this.drag.active) return;
      const r = card.getBoundingClientRect();
      const fx = (e.clientX - r.left) / r.width;
      const fy = (e.clientY - r.top) / r.height;
      card.style.setProperty('--ry', `${((fx - 0.5) * 18).toFixed(1)}deg`);
      card.style.setProperty('--rx', `${((0.5 - fy) * 14).toFixed(1)}deg`);
      card.style.setProperty('--mx', `${(fx * 100).toFixed(0)}%`);
      card.style.setProperty('--my', `${(fy * 100).toFixed(0)}%`);
    });
    // A staged spell can target a Lab: click anywhere on that player's area (not on a card).
    this.el.addEventListener('click', (e) => {
      const st = this.controller.staged();
      const t = e.target as Element;
      if (!st || t.closest('.card, button, .spell-stage')) return;
      const area = t.closest('.area') as HTMLElement | null;
      const key = area ? `lab:${area.dataset.seat}` : '';
      if (area && st.play.targets?.includes(key)) this.controller.chooseTarget(key);
    });
    queueMicrotask(() => this.refresh());
  }

  // ---------- spell staging (Change Request 1) ----------

  private spellStage: HTMLElement | null = null;

  /**
   * A targeted Power/Trap card waits large at the right of the battlefield: hover a target to aim
   * (red lightning), click to lock it in, then Confirm — or Cancel back to aiming / to the hand.
   */
  private renderSpellStage(view: GameView): void {
    const st = this.curtainFor === null ? this.controller.staged() : null;
    for (const p of view.players) {
      const area = this.board.areaFor(p.seat)?.root;
      if (!area) continue;
      const key = `lab:${p.seat}`;
      const isT = !!st && !!st.play.targets?.includes(key);
      area.classList.toggle('lab-target', isT && !st!.chosen);
      area.classList.toggle('lab-locked', !!st && st.chosen === key);
    }
    this.el.classList.toggle('spell-mode', !!st);
    if (!st) {
      const old = this.spellStage;
      this.spellStage = null;
      if (old) {
        if (this.tl.instant) old.remove();
        else this.tl.done(this.tl.animate(old, [{ opacity: 1 }, { opacity: 0, transform: 'translateY(60px) scale(0.6)' }], { duration: 200, easing: EASE.inQuad, fill: 'forwards' })).then(() => old.remove());
      }
      return;
    }
    const key = `${st.play.uid}:${st.chosen ?? ''}`;
    if (this.spellStage?.dataset.key === key) return;
    const wasOpen = !!this.spellStage;
    this.spellStage?.remove();
    const def = view.defs[st.play.cardId]!;
    const card = createCardEl(null, def, { size: 'lg' });
    updateOverlays(card, def);
    card.style.setProperty('--w', '250px');
    const tName = st.chosen ? (st.chosen.startsWith('lab:') ? `${this.nameOf(Number(st.chosen.slice(4)))}'s Lab` : view.defs[view.cards[st.chosen]!.cardId]?.name ?? 'that unit') : null;
    const actions = st.chosen
      ? [h('button', { class: 'btn primary', onclick: () => this.controller.confirmSpell() }, '⚡ Confirm'), h('button', { class: 'btn', onclick: () => this.controller.unchoose() }, 'Cancel')]
      : [h('button', { class: 'btn', onclick: () => this.controller.cancel() }, 'Cancel — back to hand')];
    const stage = h('div', { class: `spell-stage${st.chosen ? ' locked' : ''}`, dataset: { key } },
      h('div', { class: 'ss-card' }, card),
      h('div', { class: 'ss-name' }, def.name),
      h('div', { class: 'ss-text' }, st.chosen ? `Target: ${tName}` : 'Hover to aim · click a target'),
      h('div', { class: 'ss-actions' }, ...actions));
    this.el.appendChild(stage);
    this.spellStage = stage;
    if (!wasOpen && !this.tl.instant) {
      const src = this.el.querySelector(`.hand .card[data-uid="${CSS.escape(st.play.uid)}"]`);
      const sr = src ? toStage(src.getBoundingClientRect()) : null;
      const dr = toStage(stage.getBoundingClientRect());
      const dx = sr ? sr.cx - dr.cx : 0;
      const dy = sr ? sr.cy - dr.cy : 300;
      this.tl.animate(stage, [{ transform: `translate(${dx}px, ${dy}px) scale(0.35)`, opacity: 0.4 }, { transform: 'translate(0, 0) scale(1.06)', opacity: 1, offset: 0.7 }, { transform: 'none', opacity: 1 }], { duration: 380, easing: EASE.outQuint });
    } else if (!this.tl.instant) {
      this.tl.animate(stage, [{ transform: 'scale(1.04)' }, { transform: 'none' }], { duration: 180, easing: EASE.outCubic });
    }
  }

  /** True while a batch of events is still animating. */
  get busy(): boolean {
    return this.playing || this.queue.length > 0;
  }

  destroy(): void {
    if (this.timer) clearInterval(this.timer.id);
    clearTimeout(this.aiTimer);
    this.unsub();
    this.unsubSettings();
    this.tl.skip();
    this.presenter.finish();
    this.fx.clear();
    this.controller.dispose();
    this.drag.dispose();
    document.removeEventListener('keydown', this.keyHandler);
    this.el.remove();
  }

  private applyLocalSettings(): void {
    const s = settings();
    this.preview.enabled = s.zoomOnHover;
    this.preview.size = s.zoomSize;
    if (!this.playing) this.render();
  }

  private nameOf(seat: unknown): string {
    if (typeof seat !== 'number') return '?';
    return this.source.seats[seat]?.name ?? `Player ${seat + 1}`;
  }

  private async send(cmd: Command): Promise<boolean> {
    if (this.viewer === null) return false;
    const r = await this.source.send(this.viewer, cmd);
    if (!r.ok) toast(`Not allowed: ${r.error}`, 'error');
    return r.ok;
  }

  // ---------- presentation queue ----------

  private async pump(): Promise<void> {
    if (this.playing) return;
    this.playing = true;
    try {
      while (this.queue.length) {
        const batch = this.queue.shift()!;
        await this.present(batch);
      }
    } finally {
      this.playing = false;
      this.tl.settle();
    }
    this.refresh();
  }

  private async present(batch: GameEvent[]): Promise<void> {
    const viewer = this.curtainFor !== null ? null : this.viewer;
    const before = this.source.eventsFor(this.events, viewer).length;
    this.events.push(...batch);
    if (this.curtainFor !== null) {
      this.render();
      return;
    }
    const visible = this.source.eventsFor(batch, viewer);
    const prevView = this.lastView;
    const start: BatchStart = {
      before: this.board.snapshot(),
      anchors: new Map(this.source.seats.map((s) => [s.seat, this.board.anchors(s.seat)!] as const).filter(([, a]) => !!a)),
      hp: new Map(prevView ? prevView.players.map((p) => [p.seat, p.labHP] as const) : []),
    };
    for (const [seat, hp] of start.hp) this.board.hpOverride.set(seat, hp);
    this.logCap = before;
    this.logCapBase = before;
    this.battleShown = this.lastBattle;
    this.render();
    await this.presenter.play(visible, start, this.lastView!, viewer);
    this.logCap = null;
    this.logCapBase = null;
    this.battleShown = null;
    this.render();
  }

  /** Reveal log lines in step with the animation: event i of the batch is now playing. */
  private revealUpTo(i: number): void {
    if (this.logCapBase === null) return;
    this.logCap = this.logCapBase + i + 1;
    this.renderLog();
  }

  private logCapBase: number | null = null;

  private showBattle(ev: GameEvent): void {
    this.battleShown = ev;
    this.renderBreakdown(true);
  }

  // ---------- perspective / curtain ----------

  /** Decide perspective / curtain, then render. Deferred while a batch is playing. */
  private refresh(): void {
    if (this.playing) {
      this.dirty = true;
      return;
    }
    this.dirty = false;
    const pub = this.source.view(null);
    if (pub.result) {
      this.el.querySelector('.curtain')?.remove();
      this.curtainFor = null;
      this.render();
      if (!this.resultsShown) {
        this.resultsShown = true;
        this.showResults(pub);
      }
      return;
    }
    const p = pub.prompt;
    const owner = p && this.source.seats[p.seat]?.kind === 'local' ? p.seat : null;
    const locals = this.source.seats.filter((s) => s.kind === 'local').length;
    if (owner !== null && owner !== this.viewer) {
      if (locals > 1) {
        if (this.curtainFor !== owner) this.showCurtain(owner);
        else this.render();
        return;
      }
      this.viewer = owner;
    }
    if (this.curtainFor !== null && (owner === null || owner === this.viewer)) {
      this.el.querySelector('.curtain')?.remove();
      this.curtainFor = null;
    }
    this.render();
  }

  private showCurtain(seat: Seat): void {
    this.curtainFor = seat;
    this.preview.hide();
    this.render();
    this.el.querySelector('.curtain')?.remove();
    const logo = artUrl('ui/logo', 'md');
    const btn = h('button', { class: 'btn primary', style: 'font-size:20px;padding:14px 34px' }, `I am ${this.nameOf(seat)} — show my hand`);
    const curtain = h(
      'div',
      { class: 'curtain', role: 'dialog', 'aria-modal': 'true', 'aria-label': `Pass to ${this.nameOf(seat)}` },
      h('div', { class: 'inner' }, logo ? h('img', { class: 'logo', src: logo, alt: '' }) : null, h('h1', { style: { color: SEAT_COLORS[seat] } }, `Pass to ${this.nameOf(seat)}`), h('p', null, 'Hidden information: only the named player should look at the screen.'), btn),
    );
    btn.addEventListener('click', () => {
      curtain.remove();
      this.curtainFor = null;
      const p = this.source.view(null).prompt;
      this.viewer = p && this.source.seats[p.seat]?.kind === 'local' ? p.seat : seat;
      this.refresh();
    });
    this.el.appendChild(curtain);
    requestAnimationFrame(() => btn.focus({ preventScroll: true }));
  }

  // ---------- rendering ----------

  private lastView: GameView | null = null;

  render(): void {
    const curtained = this.curtainFor !== null;
    const viewer = curtained ? null : this.viewer;
    const view = this.source.view(viewer);
    this.lastView = view;
    this.namer.learn(view);
    // Decisions wait until the animations showing how we got here have finished (a re-roll
    // prompt must not cover the dice it is about).
    const legal: LegalView | null = !curtained && !this.playing && viewer !== null && view.prompt?.seat === viewer ? this.source.legal(viewer) : null;
    this.controller.sync(view, curtained ? null : legal);
    this.board.render(view);
    this.decorateExtras(view);
    this.renderSpellStage(view);
    this.renderSide(view, legal);
    this.board.root.toggleAttribute('inert', curtained);
    this.syncTimer(view, legal);
    this.maybeRunAi();
    if (this.opts.tutorial && !this.playing && !curtained && viewer !== null) {
      this.opts.tutorial.update({ view, legal, events: this.source.eventsFor(this.events, viewer), me: viewer });
    }
  }

  /** Online: show the server's countdown (response window / turn timer); the server acts on expiry. */
  private syncServerTimer(legal: LegalView | null): void {
    const d = this.source.deadline!();
    const key = d && legal && d.seat === legal.seat ? `${d.kind}:${d.at}` : '';
    if (!key) {
      if (this.timer) clearInterval(this.timer.id);
      this.timer = null;
      return;
    }
    if (this.timer?.key === key) {
      for (const el of this.timer.els) if (!el.isConnected) this.promptBox.append(el);
      return;
    }
    if (this.timer) clearInterval(this.timer.id);
    const total = Math.max(1, d!.at - Date.now());
    const bar = h('div', { class: 'timer-bar' }, h('div', { class: 'timer-fill' }));
    const label = h('div', { class: 'timer-label' });
    this.promptBox.append(bar, label);
    const tick = () => {
      const left = Math.max(0, d!.at - Date.now());
      (bar.firstChild as HTMLElement).style.transform = `scaleX(${left / total})`;
      label.textContent = d!.kind === 'response' ? `Response window ${Math.ceil(left / 1000)} s` : `${Math.ceil(left / 1000)} s`;
    };
    this.timer = { key, deadline: d!.at, id: window.setInterval(tick, 200), els: [bar, label] };
    tick();
  }

  /**
   * Computer seats in local games act after the animation queue settles, with a short
   * delay (scaled by the animation speed) so a human can follow (spec C5).
   */
  private maybeRunAi(): void {
    if (this.playing) return;
    const pub = this.source.view(null);
    const p = pub.prompt;
    const seat = p ? this.source.seats[p.seat] : undefined;
    if (!p || pub.result || seat?.kind !== 'ai') return;
    const key = `${pub.commandCount}:${p.seat}:${p.kind}`;
    if (key === this.aiKey) return;
    this.aiKey = key;
    clearTimeout(this.aiTimer);
    const base = p.kind === 'priority' ? 260 : p.kind === 'main' ? 650 : 480;
    this.aiTimer = window.setTimeout(() => {
      const legal = this.source.legal(p.seat);
      if (!legal || this.source.view(null).commandCount !== pub.commandCount) return;
      const cmd = chooseCommand(seat.aiLevel ?? 'normal', this.source.view(p.seat), legal, rules, this.aiRng);
      void this.source.send(p.seat, cmd).then((r) => {
        if (!r.ok) console.warn('AI command rejected', r.error, cmd);
      });
    }, Math.round(base * speedFactor()));
  }

  /**
   * Optional turn timer (house rule J, off by default). In local games each decision gets
   * the configured time; on expiry its default answer is applied. Online, the server owns it.
   */
  private syncTimer(view: GameView, legal: LegalView | null): void {
    if (this.source.deadline) return this.syncServerTimer(legal);
    const secs = settings().turnTimer;
    const key = legal ? `${view.commandCount}:${legal.prompt.kind}:${legal.seat}` : '';
    if (!secs || !legal || this.source.seats[legal.seat]?.kind !== 'local') {
      if (this.timer) clearInterval(this.timer.id);
      this.timer = null;
      return;
    }
    if (this.timer?.key === key) {
      for (const el of this.timer.els) if (!el.isConnected) this.promptBox.append(el);
      return;
    }
    if (this.timer) clearInterval(this.timer.id);
    const deadline = Date.now() + secs * 1000;
    const bar = h('div', { class: 'timer-bar' }, h('div', { class: 'timer-fill' }));
    const label = h('div', { class: 'timer-label' });
    this.promptBox.append(bar, label);
    const tick = () => {
      const left = Math.max(0, deadline - Date.now());
      (bar.firstChild as HTMLElement).style.transform = `scaleX(${left / (secs * 1000)})`;
      label.textContent = `${Math.ceil(left / 1000)} s`;
      if (left <= 0 && this.timer?.key === key) {
        clearInterval(this.timer.id);
        this.timer = null;
        const cmd = this.controller.timeoutDefault();
        if (cmd) {
          toast('Time is up — the default choice was made.', 'warn');
          void this.send(cmd);
        }
      }
    };
    this.timer = { key, deadline, id: window.setInterval(tick, 250), els: [bar, label] };
    tick();
  }

  /** Commander halos + tethers to the units receiving the bonus; danger rim on likely losers. */
  private decorateExtras(view: GameView): void {
    // "Waiting for …" on the area of whoever must decide (not you), so a pause is never a mystery.
    for (const p of view.players) {
      const area = this.board.areaFor(p.seat)?.root;
      if (!area) continue;
      area.querySelector(':scope > .wait-pill')?.remove();
      if (view.prompt && view.prompt.seat === p.seat && p.seat !== view.viewer && !view.result) {
        area.appendChild(h('div', { class: 'wait-pill' }, `Waiting for ${this.nameOf(p.seat)}…`));
      }
    }
    const els = this.board.elements();
    const tethers: string[] = [];
    const attacking = new Set((view.battle?.attacks ?? []).filter((a) => a.status === 'pending').flatMap((a) => a.units));
    const pos = (el: HTMLElement) => {
      const st = document.getElementById('stage')!.getBoundingClientRect();
      const s = st.width / 1920 || 1;
      const r = el.getBoundingClientRect();
      return { x: (r.left + r.width / 2 - st.left) / s, y: (r.top + r.height / 2 - st.top) / s };
    };
    for (const p of view.players) {
      for (const uid of p.lab) {
        const def = view.defs[view.cards[uid]!.cardId]!;
        const el = els.get(uid);
        if (!el) continue;
        const aura = def.effects.find((e) => e.trigger === 'StaticAura');
        el.classList.toggle('commander-halo', !!aura);
        if (!aura || settings().glow === 'off') continue;
        const from = pos(el);
        for (const target of p.lab) {
          if (!attacking.has(target)) continue;
          const td = view.defs[view.cards[target]!.cardId]!;
          if (td.unitType !== aura.params.unitType) continue;
          const tel = els.get(target);
          if (!tel) continue;
          const to = pos(tel);
          tethers.push(`<line x1="${from.x}" y1="${from.y}" x2="${to.x}" y2="${to.y}" />`);
        }
      }
    }
    this.tethers.setAttribute('viewBox', '0 0 1920 1080');
    this.tethers.innerHTML = tethers.join('');

    // Danger rim: a side likely (>= 55%) to be destroyed in its battle as currently assigned.
    for (const el of els.values()) el.classList.remove('danger');
    const tentative = this.controller.tentativeBlocks();
    const sum = (uids: string[]): { cyber: number; psionic: number; physical: number } => {
      const out = { cyber: 0, psionic: 0, physical: 0 };
      for (const u of uids) {
        const st: UnitStats | undefined = view.unitStats[u];
        if (!st) continue;
        for (const k of ['cyber', 'psionic', 'physical'] as const) out[k] += st[k] === 'X' ? 3 : (st[k] as number);
      }
      return out;
    };
    for (const atk of view.battle?.attacks ?? []) {
      if (atk.status !== 'pending') continue;
      let blockers = atk.blockers;
      if (!blockers.length && tentative.has(atk.id)) {
        const b = tentative.get(atk.id)!;
        const partner = view.cards[b]?.stackPartner;
        blockers = partner ? [b, partner] : [b];
      }
      if (!blockers.length) continue;
      const odds = battleOdds(rules, view.config.diceVariant, sum(atk.units), sum(blockers));
      if (odds.attDestroyed >= 0.55) for (const u of atk.units) els.get(u)?.classList.add('danger');
      if (odds.defDestroyed >= 0.55) for (const u of blockers) els.get(u)?.classList.add('danger');
    }
  }

  /** Turn order, always visible: every seat in play order, the active one marked, HP shown. */
  private turnOrder(view: GameView): HTMLElement {
    const n = view.players.length;
    const kids: Node[] = [];
    for (let i = 0; i < n; i++) {
      const seat = (view.turn.firstPlayer + i) % n;
      const p = view.players[seat]!;
      const name = this.nameOf(seat);
      if (i) kids.push(h('span', { class: 'to-arrow', 'aria-hidden': 'true' }, '›'));
      kids.push(h('div', {
        class: `to-chip${seat === view.turn.active ? ' active' : ''}${p.eliminated ? ' out' : ''}${name.endsWith('(offline)') ? ' offline' : ''}`,
        style: { '--seat-color': SEAT_COLORS[seat] } as any,
        title: `${name}${seat === view.turn.active ? ' — taking their turn' : ''}${p.eliminated ? ' — out' : ''}`,
        role: 'listitem',
      }, h('span', { class: 'to-name' }, name.replace(' (offline)', '')), h('span', { class: 'to-hp' }, p.eliminated ? 'out' : `${Math.max(0, p.labHP)} HP`)));
    }
    return h('div', { class: 'turn-order', role: 'list', 'aria-label': 'Turn order' }, ...kids);
  }

  private renderSide(view: GameView, legal: LegalView | null): void {
    const act = view.turn.active;
    const pi = PHASES.indexOf(view.phase as any);
    const si = STEPS.indexOf(view.step as any);
    this.turnBox.replaceChildren(
      h('div', { class: 'turn-line' }, h('span', { class: 'who', style: { color: SEAT_COLORS[act] } }, `${this.nameOf(act)}'s turn`), h('span', { class: 'dim' }, `Turn ${view.turn.number}`)),
      h('div', { class: 'phases', role: 'list', 'aria-label': 'Phases' }, ...PHASES.map((ph, i) => h('div', { class: `phase${i === pi ? ' now' : i < pi ? ' done' : ''}`, role: 'listitem', 'aria-current': i === pi ? 'step' : undefined }, PHASE_LABEL[ph]))),
      h('div', { class: 'steps', 'aria-hidden': 'true', style: { visibility: view.phase === 'battle' ? 'visible' : 'hidden' } }, ...STEPS.map((_, i) => h('span', { class: i === si ? 'now' : i < si ? 'done' : '' }))),
      h('div', { class: 'step-name' }, view.phase === 'battle' && view.step ? STEP_LABEL[view.step] : ''),
      this.turnOrder(view),
    );

    const kids: Node[] = [];
    if (legal) {
      kids.push(h('div', { class: 'prompt-label' }, legal.prompt.label));
      kids.push(h('div', { class: 'prompt-hint' }, this.controller.hint()));
      const btns = this.controller.buttons().map((b) =>
        h('button', {
          class: `btn${b.primary ? ' primary' : ''}${b.danger ? ' danger' : ''}${b.color ? ' target-chip small' : ''}${b.active ? ' active' : ''}`,
          style: b.color ? ({ '--seat-color': b.color } as any) : undefined,
          'aria-pressed': b.color ? String(!!b.active) : undefined,
          disabled: b.disabled, onclick: b.onClick,
        }, b.label, b.key ? h('kbd', null, b.key) : null),
      );
      kids.push(h('div', { class: 'prompt-actions' }, ...btns));
    } else if (view.prompt) {
      const s = view.prompt.seat;
      kids.push(h('div', { class: 'waiting', style: { '--seat-color': SEAT_COLORS[s] } as any }, h('span', { class: 'dot' }), `Waiting for ${this.nameOf(s)}…`));
      kids.push(h('div', { class: 'prompt-hint' }, view.prompt.label));
    } else if (view.result) {
      kids.push(h('div', { class: 'prompt-label' }, 'Game over'));
    }
    this.promptBox.replaceChildren(...kids);
    this.renderBreakdown(false);
    this.renderLog();
  }

  private visibleEvents(): GameEvent[] {
    const all = this.source.eventsFor(this.events, this.lastView?.viewer ?? null);
    return this.logCap === null ? all : all.slice(0, this.logCap);
  }

  private renderBreakdown(pop: boolean): void {
    const visible = this.visibleEvents();
    for (const e of visible) this.namer.learnEvent(e);
    const lastBattle = this.battleShown ?? [...visible].reverse().find((e) => e.type === 'BattleResolved') ?? null;
    if (lastBattle !== this.lastBattle || !this.breakdownHost.firstChild) {
      this.lastBattle = lastBattle;
      const panel = renderBreakdown(lastBattle, this.namer, (s) => this.nameOf(s), this.lastView?.config.diceVariant ?? 'standard');
      if (pop) panel.classList.add('pop');
      this.breakdownHost.replaceChildren(panel);
    }
  }

  private renderLog(): void {
    const visible = this.visibleEvents();
    const viewer = this.lastView?.viewer ?? null;
    const lines = visible.map((e) => eventLine(e, (s) => this.nameOf(s), this.namer, viewer, settings().logVerbosity)).filter((x): x is NonNullable<typeof x> => !!x).slice(-160);
    const atBottom = this.logEl.scrollTop + this.logEl.clientHeight >= this.logEl.scrollHeight - 30;
    this.logEl.replaceChildren(h('h3', null, 'Battle log'), ...lines.map((l) => h('div', { class: `entry${l.kind ? ' ' + l.kind : ''}` }, l.text)));
    if (atBottom) this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  private hover(ctx: CardCtx | null, el?: HTMLElement): void {
    if (!ctx || this.curtainFor !== null || this.drag.active) {
      this.preview.hide();
      return;
    }
    const view = this.lastView ?? this.source.view(this.viewer);
    const rect = el?.getBoundingClientRect();
    const stage = this.el.getBoundingClientRect();
    const side = rect && rect.left - stage.left < stage.width * 0.32 ? 'right' : 'left';
    this.preview.show(ctx.def, { stats: view.unitStats[ctx.uid], side });
  }

  private openDiscard(seat: Seat): void {
    const view = this.source.view(this.viewer);
    const p = view.players[seat]!;
    const cards = [...p.discard].reverse().map((u) => {
      const def = view.defs[view.cards[u]!.cardId]!;
      const el = createCardEl(u, def, { size: 'md' });
      el.addEventListener('pointerenter', () => this.preview.show(def, { side: 'left' }));
      el.addEventListener('pointerleave', () => this.preview.hide());
      return el;
    });
    let m: ReturnType<typeof openModal>;
    m = openModal(this.el, `${p.name}'s discard pile`, `${p.discard.length} cards (public)`, h('div', { class: 'choice-grid' }, ...(cards.length ? cards : [h('div', { class: 'faint' }, 'Empty')])), [{ label: 'Close', primary: true, onClick: () => m.close() }], { dismissable: true, className: 'discard-viewer' });
  }

  private async exportLog(): Promise<void> {
    const log = await this.source.exportLog?.();
    if (!log) return;
    const blob = new Blob([JSON.stringify(log, null, 2)], { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `psi-wars-log-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  private openMenu(): void {
    let m: ReturnType<typeof openModal>;
    const actions = [
      { label: 'Rules reference', onClick: () => { m.close(); this.openRules(); } },
      { label: 'Export game log', onClick: () => void this.exportLog() },
      ...(this.opts.openSettings ? [{ label: 'Settings', onClick: () => { m.close(); this.opts.openSettings!(this.el); } }] : []),
      ...(this.opts.readOnly ? [] : [{ label: 'Concede', danger: true, onClick: () => { m.close(); if (this.viewer !== null) void this.source.send(this.viewer, { type: 'Concede' }); } }]),
      { label: this.opts.readOnly ? 'Close replay' : 'Quit to main menu', onClick: () => { m.close(); this.opts.onExit(); } },
      { label: 'Resume', primary: true, onClick: () => m.close() },
    ];
    m = openModal(this.el, 'Game menu', null, null, actions, { dismissable: true });
  }

  private openRules(): void {
    const close = () => {
      wrap.remove();
      document.removeEventListener('keydown', esc, true);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      }
    };
    const wrap: HTMLElement = h('div', {
      class: 'modal-backdrop rules-modal-wrap', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Rules reference',
      onclick: (e: MouseEvent) => { if (e.target === wrap) close(); },
    }, h('div', { class: 'rules-modal panel' }, rulesReference(close)));
    document.addEventListener('keydown', esc, true);
    this.el.appendChild(wrap);
  }

  /** Per-player statistics for the results screen, derived from the game's public events. */
  private gameStats(view: GameView): Map<Seat, { damage: number; killed: number; lost: number; played: number; won: number; fought: number }> {
    const out = new Map(view.players.map((p): [Seat, { damage: number; killed: number; lost: number; played: number; won: number; fought: number }] => [p.seat, { damage: 0, killed: 0, lost: 0, played: 0, won: 0, fought: 0 }]));
    const events = this.source.eventsFor(this.events, null);
    const attackSeat = new Map<string, Seat>();
    const fights = new Map<string, { att: Seat; def: Seat }>();
    for (const e of events) {
      if (e.type === 'UnblockedHit') attackSeat.set(e.attackId as string, e.seat as Seat);
      if (e.type === 'BattleResolved') {
        const att = (e.att as { seat: Seat }).seat;
        const def = (e.def as { seat: Seat }).seat;
        fights.set(e.attackId as string, { att, def });
        out.get(att)!.fought++;
        out.get(def)!.fought++;
        const w = (e.winners as { physical: 'att' | 'def' | null }).physical;
        if (w) out.get(w === 'att' ? att : def)!.won++;
      }
    }
    for (const e of events) {
      if (e.type === 'CardPlayed' && e.cardType !== 'Resource') out.get(e.seat as Seat)!.played++;
      if (e.type === 'LabDamaged') {
        const src = e.source as string | null;
        const dealer = src ? attackSeat.get(src) ?? view.cards[src]?.owner : undefined;
        if (dealer !== undefined && dealer !== e.seat) out.get(dealer)!.damage += e.amount as number;
      }
      if (e.type === 'UnitDestroyed') {
        const owner = e.seat as Seat;
        out.get(owner)!.lost++;
        const f = e.attackId ? fights.get(e.attackId as string) : undefined;
        if (f) out.get(f.att === owner ? f.def : f.att)!.killed++;
      }
    }
    return out;
  }

  private showResults(view: GameView): void {
    const r = view.result!;
    const me = this.viewer;
    const won = me !== null && r.winners.includes(me);
    const solo = this.source.seats.filter((s) => s.kind === 'local').length === 1 && me !== null;
    const title = r.draw ? 'Draw' : solo ? (won ? 'Victory!' : 'Defeat') : `${r.winners.map((w) => this.nameOf(w)).join(', ')} wins!`;
    const reason = { labDestroyed: 'Lab destroyed', noBattleUnits: 'No Battle Units left', simultaneousLoss: 'Simultaneous loss', conceded: 'Concession', turnLimit: 'Turn limit reached' }[r.reason] ?? r.reason;
    const st = this.gameStats(view);
    const heads = ['Player', 'Lab HP', 'Damage dealt', 'Units destroyed', 'Units lost', 'Battles won', 'Cards played', 'Units left'];
    const stats = h(
      'table',
      { class: 'results-table' },
      h('tr', null, ...heads.map((t) => h('th', null, t))),
      ...view.players.map((p) => {
        const x = st.get(p.seat)!;
        const units = p.lab.filter((u) => view.defs[view.cards[u]!.cardId]?.cardType === 'BattleUnit').length;
        const win = r.winners.includes(p.seat);
        return h('tr', { class: win ? 'winner' : '' },
          h('td', { style: { color: SEAT_COLORS[p.seat] } }, win ? '★ ' : '', this.nameOf(p.seat)),
          h('td', null, String(Math.max(0, p.labHP))), h('td', null, String(x.damage)), h('td', null, String(x.killed)), h('td', null, String(x.lost)),
          h('td', null, `${x.won} / ${x.fought}`), h('td', null, String(x.played)), h('td', null, String(units)));
      }),
    );
    const sub = `${r.draw || !solo ? '' : `${r.winners.map((w) => this.nameOf(w)).join(', ')} won · `}${reason} · ${view.turn.number} turns`;
    const body = h('div', null, h('p', { class: 'dim results-sub' }, sub), stats);
    let m: ReturnType<typeof openModal>;
    const actions: { label: string; primary?: boolean; onClick: () => void }[] = [
      { label: 'View board', onClick: () => { m.close(); this.showGameOverBar(); } },
      { label: 'Export log', onClick: () => void this.exportLog() },
      { label: 'Main menu', onClick: () => { m.close(); this.opts.onExit(); } },
    ];
    if (this.opts.onRematch) actions.push({ label: 'Rematch', primary: true, onClick: () => { m.close(); this.opts.onRematch!(); } });
    else actions[2]!.primary = true;
    m = openModal(this.el, title, null, body, actions, { className: `results${won ? ' won' : r.draw || me === null ? '' : ' lost'}` });
  }

  /** After "View board": a slim bar to get back to the results. */
  private showGameOverBar(): void {
    this.el.querySelector('.gameover-bar')?.remove();
    const bar = h('div', { class: 'gameover-bar panel' }, h('span', null, 'Game over'), h('button', { class: 'btn small primary', onclick: () => { bar.remove(); this.showResults(this.source.view(this.viewer)); } }, 'Show results'));
    this.el.appendChild(bar);
  }

  private onKey(e: KeyboardEvent): void {
    if (this.curtainFor !== null) return;
    if (this.playing && this.tl.busy && (e.key === ' ' || e.key === 'Enter' || e.key === 'Escape')) {
      this.tl.skip();
      e.preventDefault();
      return;
    }
    if (this.controller.onKey(e)) {
      e.preventDefault();
      this.refresh();
    }
  }
}
