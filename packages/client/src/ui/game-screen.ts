import type { Command, GameEvent, Seat } from '@psi-wars/shared';
import type { GameView, LegalView } from '@psi-wars/engine';
import { artUrl } from '../assets';
import { Board, SEAT_COLORS, type CardCtx } from '../render/board';
import { renderBreakdown } from '../render/breakdown';
import { createCardEl } from '../render/card';
import { eventLine, Namer, type Verbosity } from '../render/log';
import type { GameSource } from '../game/source';
import { Controller } from './controller';
import { h, toast } from './dom';
import { openModal } from './modals';
import { Preview } from './preview';

const PHASES = ['replenish', 'draw', 'creation', 'battle', 'cleanup'] as const;
const PHASE_LABEL = { replenish: 'Replenish', draw: 'Draw', creation: 'Create', battle: 'Battle', cleanup: 'Cleanup' };
const STEPS = ['declareAttackers', 'declareBlockers', 'power', 'cyborg', 'determination'] as const;
const STEP_LABEL: Record<string, string> = { declareAttackers: '1 · Attackers', declareBlockers: '2 · Defenders', power: '3 · Power cards', cyborg: '4 · Cyborg abilities', determination: '5 · Battle determination' };

export interface GameScreenOpts {
  onExit: () => void;
  onRematch?: () => void;
  verbosity?: () => Verbosity;
  alwaysChips?: () => boolean;
}

/**
 * The game screen. Hot-seat rules: the board is drawn from the perspective of `viewer`;
 * whenever a decision passes to a different local human, a full-screen curtain hides
 * everything (the board underneath is re-rendered as a spectator) until they confirm.
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
  private events: GameEvent[] = [];
  private lastBattle: GameEvent | null = null;
  private unsub: () => void;
  private resultsShown = false;
  private keyHandler = (e: KeyboardEvent) => this.onKey(e);

  constructor(private source: GameSource, initialEvents: GameEvent[], private opts: GameScreenOpts) {
    this.namer = new Namer(() => this.source.view(null).defs);
    const firstLocal = source.seats.find((s) => s.kind === 'local');
    this.viewer = firstLocal?.seat ?? null;
    this.board = new Board({
      decorate: (el, ctx) => this.controller.decorate(el, ctx),
      click: (ctx, ev) => void this.controller.click(ctx, ev),
      hover: (ctx, el) => this.hover(ctx, el),
      openDiscard: (seat) => this.openDiscard(seat),
      tentativeBlocks: () => this.controller.tentativeBlocks(),
      alwaysChips: () => this.opts.alwaysChips?.() ?? false,
    });
    const menuBtn = h('button', { class: 'btn small ghost game-menu-btn', 'aria-label': 'Game menu', onclick: () => this.openMenu() }, '☰ Menu');
    const side = h('aside', { class: 'side' }, h('div', { class: 'side-top' }, menuBtn), this.turnBox, this.promptBox, this.breakdownHost, this.logEl);
    this.el = h('div', { class: 'game-screen' }, this.board.root, side, this.preview.el);
    const bg = artUrl('ui/menu-bg', '1920');
    if (bg) this.el.style.setProperty('--menu-bg', `url(${bg})`);
    this.controller = new Controller(this.el, (cmd) => this.send(cmd), () => this.refresh(), (s) => this.nameOf(s));
    this.ingest(initialEvents);
    this.unsub = source.onUpdate((u) => {
      this.ingest(u.events);
      this.refresh();
    });
    document.addEventListener('keydown', this.keyHandler);
    queueMicrotask(() => this.refresh());
  }

  destroy(): void {
    this.unsub();
    this.controller.dispose();
    document.removeEventListener('keydown', this.keyHandler);
    this.el.remove();
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

  private ingest(events: GameEvent[]): void {
    this.events.push(...events);
  }

  /** Decide perspective / curtain, then render. */
  private refresh(): void {
    const pub = this.source.view(null);
    if (pub.result) {
      // Game over: nothing is hidden any more; drop any curtain and show the final board.
      this.el.querySelector('.curtain')?.remove();
      this.curtainFor = null;
      this.render();
      if (!this.resultsShown) {
        this.resultsShown = true;
        this.showResults(pub);
      }
      return;
    }
    // The curtain is derived from the current prompt every time, so it can never go stale:
    // a decision owned by a different local human always hides the screen first.
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
      // Reveal whoever holds the decision *now* (it may have moved on while the curtain was up).
      const p = this.source.view(null).prompt;
      this.viewer = p && this.source.seats[p.seat]?.kind === 'local' ? p.seat : seat;
      this.refresh();
    });
    this.el.appendChild(curtain);
    requestAnimationFrame(() => btn.focus({ preventScroll: true }));
  }

  render(): void {
    const curtained = this.curtainFor !== null;
    const viewer = curtained ? null : this.viewer;
    const view = this.source.view(viewer);
    this.namer.learn(view);
    const legal: LegalView | null = !curtained && viewer !== null && view.prompt?.seat === viewer ? this.source.legal(viewer) : null;
    this.controller.sync(view, curtained ? null : legal);
    this.board.render(view);
    this.renderSide(view, legal);
    this.board.root.toggleAttribute('inert', curtained);
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
    );

    const kids: Node[] = [];
    if (legal) {
      kids.push(h('div', { class: 'prompt-label' }, legal.prompt.label));
      kids.push(h('div', { class: 'prompt-hint' }, this.controller.hint()));
      const btns = this.controller.buttons().map((b) =>
        h('button', { class: `btn${b.primary ? ' primary' : ''}${b.danger ? ' danger' : ''}`, disabled: b.disabled, onclick: b.onClick }, b.label, b.key ? h('kbd', null, b.key) : null),
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

    // Battle breakdown: last BattleResolved event visible to this viewer
    const visible = this.source.eventsFor(this.events, view.viewer);
    for (const e of visible) this.namer.learnEvent(e);
    const lastBattle = [...visible].reverse().find((e) => e.type === 'BattleResolved') ?? null;
    if (lastBattle !== this.lastBattle || !this.breakdownHost.firstChild) {
      this.lastBattle = lastBattle;
      this.breakdownHost.replaceChildren(renderBreakdown(lastBattle, this.namer, (s) => this.nameOf(s), view.config.diceVariant));
    }

    // Log
    const verbosity = this.opts.verbosity?.() ?? 'normal';
    const lines = visible.map((e) => eventLine(e, (s) => this.nameOf(s), this.namer, view.viewer, verbosity)).filter((x): x is NonNullable<typeof x> => !!x).slice(-160);
    const atBottom = this.logEl.scrollTop + this.logEl.clientHeight >= this.logEl.scrollHeight - 30;
    this.logEl.replaceChildren(h('h3', null, 'Battle log'), ...lines.map((l) => h('div', { class: `entry${l.kind ? ' ' + l.kind : ''}` }, l.text)));
    if (atBottom) this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  private hover(ctx: CardCtx | null, el?: HTMLElement): void {
    if (!ctx || this.curtainFor !== null) {
      this.preview.hide();
      return;
    }
    const view = this.source.view(this.viewer);
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

  private openMenu(): void {
    let m: ReturnType<typeof openModal>;
    const exportLog = () => {
      const log = this.source.exportLog?.();
      if (!log) return;
      const blob = new Blob([JSON.stringify(log, null, 2)], { type: 'application/json' });
      const a = h('a', { href: URL.createObjectURL(blob), download: `psi-wars-log-${Date.now()}.json` });
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    };
    m = openModal(this.el, 'Game menu', null, null, [
      { label: 'Export game log', onClick: () => exportLog() },
      { label: 'Concede', danger: true, onClick: () => { m.close(); if (this.viewer !== null) void this.source.send(this.viewer, { type: 'Concede' }); } },
      { label: 'Quit to main menu', onClick: () => { m.close(); this.opts.onExit(); } },
      { label: 'Resume', primary: true, onClick: () => m.close() },
    ], { dismissable: true });
  }

  private showResults(view: GameView): void {
    const r = view.result!;
    const title = r.draw ? 'Draw' : `${r.winners.map((w) => this.nameOf(w)).join(', ')} wins!`;
    const reason = { labDestroyed: 'Lab destroyed', noBattleUnits: 'No Battle Units left', simultaneousLoss: 'Simultaneous loss', conceded: 'Concession', turnLimit: 'Turn limit reached' }[r.reason] ?? r.reason;
    const stats = h(
      'table',
      { class: 'results-table' },
      h('tr', null, h('th', null, 'Player'), h('th', null, 'Lab HP'), h('th', null, 'Units in Lab'), h('th', null, 'Discard')),
      ...view.players.map((p) => h('tr', null, h('td', { style: { color: SEAT_COLORS[p.seat] } }, p.name), h('td', null, String(p.labHP)), h('td', null, String(p.lab.length)), h('td', null, String(p.discard.length)))),
    );
    const body = h('div', null, h('p', { class: 'dim' }, `${reason} · ${view.turn.number} turns`), stats);
    let m: ReturnType<typeof openModal>;
    const actions = [
      { label: 'Export log', onClick: () => { const log = this.source.exportLog?.(); if (log) { const a = h('a', { href: URL.createObjectURL(new Blob([JSON.stringify(log, null, 2)])), download: 'psi-wars-log.json' }); a.click(); } } },
      { label: 'Main menu', onClick: () => { m.close(); this.opts.onExit(); } },
    ];
    if (this.opts.onRematch) actions.push({ label: 'Rematch', onClick: () => { m.close(); this.opts.onRematch!(); } });
    m = openModal(this.el, title, null, body, actions, { className: 'results' });
  }

  private onKey(e: KeyboardEvent): void {
    if (this.curtainFor !== null) return;
    if (this.controller.onKey(e)) {
      e.preventDefault();
      this.refresh();
    }
  }
}
