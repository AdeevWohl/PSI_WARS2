/**
 * Dice as real 3D cubes (CSS 3D transforms) faced with the SVG die faces. They tumble in,
 * bounce and settle on the rolled face. Setting "2D flip" flips a flat face; "instant" shows it.
 */
import type { Ability } from '@psi-wars/shared';
import { settings } from '../settings';
import { dieSvg } from '../render/dice';
import { h, svg } from '../ui/dom';
import { EASE, type Timeline } from './timeline';

// Which cube face shows each side, and the cube rotation that brings it to the front.
const FACE_OF: Record<number, string> = { 1: 'front', 6: 'back', 3: 'right', 4: 'left', 2: 'top', 5: 'bottom' };
const SHOW: Record<number, [number, number]> = { 1: [0, 0], 6: [0, 180], 3: [0, -90], 4: [0, 90], 2: [-90, 0], 5: [90, 0] };

export class Die3D {
  readonly el: HTMLElement;
  private cube: HTMLElement;
  private flat: HTMLElement;
  side: number;

  constructor(readonly die: Ability, side: number, readonly variant: 'standard' | 'noModifier', readonly size = 64) {
    this.side = side;
    this.cube = h('div', { class: 'cube' });
    for (const s of [1, 2, 3, 4, 5, 6]) {
      const f = h('div', { class: `face3d f-${FACE_OF[s]}` });
      f.appendChild(svg(dieSvg(die, s, { size, variant })));
      this.cube.appendChild(f);
    }
    this.flat = h('div', { class: 'die-flat' });
    this.flat.appendChild(svg(dieSvg(die, side, { size, variant })));
    const mode = settings().dice;
    this.el = h('div', { class: `die3d mode-${mode}`, style: { '--size': `${size}px` } as any }, mode === '3d' ? this.cube : this.flat);
    this.setRest(side);
  }

  private setRest(side: number): void {
    const [x, y] = SHOW[side]!;
    this.cube.style.transform = `rotateX(${x}deg) rotateY(${y}deg)`;
    this.flat.replaceChildren(svg(dieSvg(this.die, side, { size: this.size, variant: this.variant })));
  }

  /** Tumble in and settle on `side`. */
  roll(tl: Timeline, side: number, delay = 0): Animation | null {
    this.side = side;
    const mode = settings().dice;
    this.setRest(side);
    if (mode === 'instant' || tl.instant) return null;
    if (mode === '2d') {
      return tl.animate(this.el, [{ transform: 'scaleX(0) translateY(-30px)' }, { transform: 'scaleX(-1) translateY(-12px)', offset: 0.4 }, { transform: 'scaleX(1) translateY(0)' }], { duration: 520, easing: EASE.outBack, delay, fill: 'backwards' });
    }
    const [x, y] = SHOW[side]!;
    const sx = 720 + Math.round(Math.random() * 2) * 90;
    const sy = 720 + Math.round(Math.random() * 2) * 90;
    tl.animate(this.el, [{ transform: 'translateY(-90px) scale(0.6)', opacity: 0 }, { transform: 'translateY(6px) scale(1.05)', opacity: 1, offset: 0.55 }, { transform: 'translateY(-10px)', offset: 0.75 }, { transform: 'translateY(0) scale(1)' }], { duration: 760, easing: EASE.outCubic, delay, fill: 'backwards' });
    return tl.animate(this.cube, [{ transform: `rotateX(${x + sx}deg) rotateY(${y + sy}deg)` }, { transform: `rotateX(${x - 12}deg) rotateY(${y + 14}deg)`, offset: 0.8 }, { transform: `rotateX(${x}deg) rotateY(${y}deg)` }], { duration: 760, easing: EASE.outQuint, delay, fill: 'backwards' });
  }

  /** Re-roll: the die lifts and spins in place, then lands on the new side. */
  reroll(tl: Timeline, side: number): Animation | null {
    if (tl.instant || settings().dice === 'instant') {
      this.setRest(side);
      return null;
    }
    tl.animate(this.el, [{ transform: 'translateY(0)' }, { transform: 'translateY(-40px)', offset: 0.4 }, { transform: 'translateY(0)' }], { duration: 640, easing: EASE.outCubic });
    return this.roll(tl, side);
  }

  shatter(tl: Timeline): Animation {
    this.el.classList.add('destroyed');
    return tl.animate(this.el, [{ transform: 'scale(1)', opacity: 1, filter: 'brightness(1)' }, { transform: 'scale(1.25)', filter: 'brightness(3)', offset: 0.2 }, { transform: 'scale(0.7) rotate(18deg)', opacity: 0.25, filter: 'grayscale(1)' }], { duration: 520, easing: EASE.outQuint, fill: 'forwards' });
  }
}
