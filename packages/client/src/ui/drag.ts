/**
 * Drag-and-drop for everything click-to-select does (§8): play cards, target Equipment and
 * Traps, move Equipment, stack (drag a unit onto its partner), declare attackers (drag to the
 * battlefield) and assign blockers (drag onto an attacker). The drag proxy is lifted to the
 * "drag" elevation tier and tilts toward the pointer's velocity (§6.5). Clicks keep working.
 */
import type { Board, CardCtx } from '../render/board';
import { flipFrom, snap, toStage } from '../anim/flip';
import { EASE, type Timeline } from '../anim/timeline';
import type { Controller, DragSpec } from './controller';

const THRESHOLD = 7;

export class DragManager {
  active = false;
  private suppressClick = false;
  private start: { x: number; y: number; ctx: CardCtx; el: HTMLElement; spec: DragSpec } | null = null;
  private proxy: HTMLElement | null = null;
  private hoverTarget: HTMLElement | null = null;
  private lastX = 0;
  private vel = 0;
  private onMove = (e: PointerEvent) => this.move(e);
  private onUp = (e: PointerEvent) => void this.up(e);

  constructor(private host: HTMLElement, private board: Board, private controller: Controller, private tl: Timeline) {
    host.addEventListener('pointerdown', (e) => this.down(e));
  }

  dispose(): void {
    this.cancel();
  }

  /** True once if the last pointer interaction was a drag (so the click is ignored). */
  consumeClick(): boolean {
    const s = this.suppressClick;
    this.suppressClick = false;
    return s;
  }

  private down(e: PointerEvent): void {
    if (e.button !== 0) return;
    const el = (e.target as HTMLElement).closest('.card') as HTMLElement | null;
    const ctx = el ? ((el as any).__ctx as CardCtx | undefined) : undefined;
    if (!el || !ctx) return;
    const spec = this.controller.dragSpec(ctx);
    if (!spec) return;
    this.start = { x: e.clientX, y: e.clientY, ctx, el, spec };
    this.lastX = e.clientX;
    window.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp, { once: true });
  }

  private move(e: PointerEvent): void {
    const st = this.start;
    if (!st) return;
    if (!this.active) {
      if (Math.hypot(e.clientX - st.x, e.clientY - st.y) < THRESHOLD) return;
      this.begin();
    }
    const p = this.proxy!;
    const o = toStage(new DOMRect(e.clientX, e.clientY, 0, 0));
    this.vel = this.vel * 0.7 + (e.clientX - this.lastX) * 0.3;
    this.lastX = e.clientX;
    const tilt = Math.max(-14, Math.min(14, this.vel * 0.9));
    p.style.transform = `translate(${o.x}px, ${o.y}px) translate(-50%, -50%) rotate(${tilt}deg) scale(1.08)`;
    // Hit-test drop targets under the pointer (proxy has pointer-events: none).
    const under = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
    const target = this.targetFrom(under);
    if (target !== this.hoverTarget) {
      this.hoverTarget?.classList.remove('drop-hover');
      this.hoverTarget = target;
      target?.classList.add('drop-hover');
    }
  }

  private targetFrom(under: HTMLElement | null): HTMLElement | null {
    const spec = this.start?.spec;
    if (!spec || !under) return null;
    const card = under.closest('.card') as HTMLElement | null;
    const uid = card?.dataset.uid;
    if (uid && spec.targets?.includes(uid)) return card;
    if (spec.zone === 'battlefield') return (under.closest('.area.opp') ?? under.closest('.battlefield')) as HTMLElement | null;
    if (spec.zone === 'board') {
      const inHand = under.closest('.hand');
      const onBoard = under.closest('.board-main');
      return onBoard && !inHand ? (onBoard as HTMLElement) : null;
    }
    return null;
  }

  private begin(): void {
    const st = this.start!;
    this.active = true;
    this.suppressClick = true;
    const r = snap(st.el);
    const proxy = st.el.cloneNode(true) as HTMLElement;
    proxy.classList.add('drag-proxy');
    proxy.style.setProperty('--w', `${st.el.offsetWidth}px`);
    proxy.style.width = `${st.el.offsetWidth}px`;
    proxy.style.transform = `translate(${r.cx}px, ${r.cy}px) translate(-50%, -50%)`;
    this.host.appendChild(proxy);
    this.proxy = proxy;
    st.el.classList.add('drag-source');
    this.host.classList.add('dragging');
    for (const uid of st.spec.targets ?? []) this.board.elements().get(uid)?.classList.add('target');
    if (st.spec.zone === 'battlefield') this.host.querySelector('.battlefield')?.classList.add('drop-zone');
  }

  private async up(e: PointerEvent): Promise<void> {
    window.removeEventListener('pointermove', this.onMove);
    const st = this.start;
    if (!this.active || !st) {
      this.start = null;
      return;
    }
    const under = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
    const target = this.targetFrom(under);
    const proxy = this.proxy;
    this.cleanupVisuals();
    if (target) {
      proxy?.remove();
      const uid = target.classList.contains('card') ? target.dataset.uid ?? null : null;
      const seat = target.classList.contains('area') && target.dataset.seat !== undefined ? Number(target.dataset.seat) : undefined;
      await this.controller.drop(st.ctx, uid, seat);
    } else if (proxy) {
      // Fly back to where it came from.
      const from = snap(proxy);
      proxy.remove();
      st.el.classList.remove('drag-source');
      flipFrom(this.tl, st.el, from, { duration: 260, easing: EASE.outCubic });
    }
    this.start = null;
    this.active = false;
  }

  private cleanupVisuals(): void {
    this.hoverTarget?.classList.remove('drop-hover');
    this.hoverTarget = null;
    this.start?.el.classList.remove('drag-source');
    this.host.classList.remove('dragging');
    this.host.querySelector('.battlefield')?.classList.remove('drop-zone');
  }

  private cancel(): void {
    window.removeEventListener('pointermove', this.onMove);
    this.cleanupVisuals();
    this.proxy?.remove();
    this.proxy = null;
    this.start = null;
    this.active = false;
  }
}
