/**
 * Dice as real 3D cubes (CSS 3D transforms) faced with the SVG die faces. They tumble in,
 * bounce and settle on the rolled face. Setting "2D flip" flips a flat face; "instant" shows it.
 */
import type { Ability } from '@psi-wars/shared';
import { playSfx } from '../audio';
import { settings } from '../settings';
import { dieSvg } from '../render/dice';
import { h, svg } from '../ui/dom';
import { EASE, type Timeline } from './timeline';

// Which cube face shows each side, and the cube rotation that brings it to the front.
const FACE_OF: Record<number, string> = { 1: 'front', 6: 'back', 3: 'right', 4: 'left', 2: 'top', 5: 'bottom' };
const SHOW: Record<number, [number, number]> = { 1: [0, 0], 6: [0, 180], 3: [0, -90], 4: [0, 90], 2: [-90, 0], 5: [90, 0] };
/** While tumbling the die is turned toward the viewer so its depth shows; it settles almost
 * face-on so the result face clearly dominates. */
const TILT_MID: [number, number] = [-20, 26];
const TILT_REST: [number, number] = [-6, 8];
const tilt = (k: number) => `rotateX(${(TILT_REST[0] + (TILT_MID[0] - TILT_REST[0]) * k).toFixed(1)}deg) rotateY(${(TILT_REST[1] + (TILT_MID[1] - TILT_REST[1]) * k).toFixed(1)}deg)`;
const TILT = tilt(0);

export class Die3D {
  readonly el: HTMLElement;
  private cube: HTMLElement;
  private flat: HTMLElement;
  side: number;

  constructor(readonly die: Ability, side: number, readonly variant: 'standard' | 'noModifier', readonly size = 64) {
    this.side = side;
    this.cube = h('div', { class: 'cube' });
    // A solid inner core fills the bevelled corners, so the die never looks hollow.
    for (const f of ['front', 'back', 'right', 'left', 'top', 'bottom']) this.cube.appendChild(h('div', { class: `core3d c-${f}` }));
    for (const s of [1, 2, 3, 4, 5, 6]) {
      const f = h('div', { class: `face3d f-${FACE_OF[s]}` });
      f.appendChild(svg(dieSvg(die, s, { size, variant })));
      this.cube.appendChild(f);
    }
    this.flat = h('div', { class: 'die-flat' });
    this.flat.appendChild(svg(dieSvg(die, side, { size, variant })));
    const mode = settings().dice;
    this.el = h('div', { class: `die3d mode-${mode} d-${die}`, style: { '--size': `${size}px` } as any }, mode === '3d' ? h('div', { class: 'die-shadow' }) : null, mode === '3d' ? this.cube : this.flat);
    this.setRest(side);
  }

  private setRest(side: number): void {
    queueMicrotask(() => {
      if (settings().dice === 'instant') this.markResult();
    });
    const [x, y] = SHOW[side]!;
    this.cube.style.transform = `${TILT} rotateX(${x}deg) rotateY(${y}deg) rotateZ(0deg)`;
    this.flat.replaceChildren(svg(dieSvg(this.die, side, { size: this.size, variant: this.variant })));
  }

  /**
   * A realistic throw: the die comes in from its owner's side (`dir` +1 = from the left), tumbles
   * along its direction of travel, bounces two or three times while slowing down, rocks a little
   * and settles on `side`. Every keyframe uses the same transform functions so the cube really
   * rotates in 3D the whole way (mismatched lists make browsers blend flat matrices).
   */
  roll(tl: Timeline, side: number, delay = 0, duration = 1150, dir: 1 | -1 = 1): Animation | null {
    this.side = side;
    const mode = settings().dice;
    this.setRest(side);
    if (mode === 'instant' || tl.instant) return null;
    if (mode === '2d') {
      return tl.animate(this.el, [{ transform: 'scaleX(0) translateY(-30px)' }, { transform: 'scaleX(-1) translateY(-12px)', offset: 0.4 }, { transform: 'scaleX(1) translateY(0)' }], { duration: 520, easing: EASE.outBack, delay, fill: 'backwards' });
    }
    const [x, y] = SHOW[side]!;
    const sz = this.size;
    // Rolling to the right turns the cube about its Y axis (and a little about X): ~1.5 turns, decelerating.
    const spinY = dir * (360 + 180 + Math.round(Math.random() * 2) * 90);
    const spinX = (Math.random() < 0.5 ? -1 : 1) * (180 + Math.round(Math.random()) * 90);
    // The view tilt eases from three-quarter (tumbling) to almost face-on (landed).
    const rot = (f: number, wob = 0) => `${tilt(Math.min(1, f / 0.15))} rotateX(${(x + spinX * f).toFixed(1)}deg) rotateY(${(y + spinY * f).toFixed(1)}deg) rotateZ(${wob.toFixed(1)}deg)`;
    const at = (fx: number, hy: number, sc = 1) => `translate(${(-dir * fx * sz * 2.6).toFixed(1)}px, ${(-hy * sz).toFixed(1)}px) scale(${sc})`;
    // Path: in from the side and above, first impact, bounce, second impact, small hop, settle.
    const path: [number, number, number, number][] = [
      // offset, distance left (1 = start), height, remaining spin
      [0, 1, 1.3, 1],
      [0.26, 0.55, 0, 0.6],
      [0.42, 0.34, 0.45, 0.4],
      [0.58, 0.18, 0, 0.22],
      [0.7, 0.09, 0.14, 0.11],
      [0.82, 0.03, 0, 0.04],
      [0.92, 0.01, 0, 0.01],
      [1, 0, 0, 0],
    ];
    tl.animate(this.el, path.map(([o, d, hgt]) => ({ offset: o, transform: at(d, hgt, o === 0 ? 0.8 : 1), opacity: o === 0 ? 0 : 1 })), { duration, easing: 'linear', delay, fill: 'backwards' });
    const shadow = this.el.querySelector('.die-shadow');
    if (shadow) tl.animate(shadow, path.map(([o, , hgt]) => ({ offset: o, transform: `translateY(${(hgt * sz).toFixed(1)}px) scale(${(1 - Math.min(hgt, 1) * 0.5).toFixed(2)})`, opacity: 1 - Math.min(hgt, 1) * 0.6 })), { duration, easing: 'linear', delay, fill: 'backwards' });
    // A clack on each impact.
    if (!tl.instant) for (const o of [0.26, 0.58, 0.82]) setTimeout(() => playSfx('dice'), tl.dur(delay + duration * o));
    this.el.classList.remove('landed');
    const anim = tl.animate(this.cube, path.map(([o, , , spin]) => ({ offset: o, transform: rot(spin, o > 0.8 && o < 1 ? (o < 0.9 ? 4 : -2) : 0) })), { duration, easing: 'linear', delay, fill: 'backwards' });
    void anim.finished.then(() => this.markResult(), () => this.markResult());
    return anim;
  }

  /** Light up the face that counts once the die has settled. */
  markResult(): void {
    this.cube.querySelectorAll('.face3d.result').forEach((f) => f.classList.remove('result'));
    this.cube.querySelector(`.f-${FACE_OF[this.side]}`)?.classList.add('result');
    this.el.classList.add('landed');
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
