/**
 * Dice faces as crisp SVG (no art supplied). Pips in the die colour; a circular-arrows
 * icon on the re-roll face; the Psi Wars hexagon for Obliterate; a small red pip marks
 * the side-5 "+1 Physical" bonus. Faces follow data/rules.json, so a dice change is a data change.
 */
import type { Ability } from '@psi-wars/shared';

export const DIE_COLOR: Record<Ability, string> = { cyber: '#3ddc5c', psionic: '#3aa0ff', physical: '#ff4a4a' };

const PIPS: Record<number, [number, number][]> = {
  1: [[50, 50]],
  2: [[30, 30], [70, 70]],
  3: [[28, 28], [50, 50], [72, 72]],
  4: [[30, 30], [70, 30], [30, 70], [70, 70]],
  5: [[28, 28], [72, 28], [50, 50], [28, 72], [72, 72]],
  6: [[30, 26], [70, 26], [30, 50], [70, 50], [30, 74], [70, 74]],
};

const HEX = (cx: number, cy: number, r: number) =>
  Array.from({ length: 6 }, (_, i) => {
    const a = (Math.PI / 3) * i - Math.PI / 2;
    return `${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`;
  }).join(' ');

export function obliterateGlyph(color: string): string {
  return `<polygon points="${HEX(50, 50, 30)}" fill="#0b1220" stroke="${color}" stroke-width="5"/>
    <polygon points="${HEX(50, 50, 21)}" fill="none" stroke="#cfd8e6" stroke-width="2.5"/>
    <circle cx="50" cy="41" r="5" fill="${color}"/>
    <path d="M37 47 L50 60 L63 47 L60 58 L50 66 L40 58 Z" fill="#e6eefc"/>`;
}

export function rerollGlyph(color: string): string {
  return `<g transform="translate(66 18) scale(0.3)" fill="none" stroke="${color}" stroke-width="10" stroke-linecap="round">
    <path d="M20 50 A30 30 0 0 1 75 32"/><path d="M80 50 A30 30 0 0 1 25 68"/>
    <path d="M62 22 L76 32 L62 42" /><path d="M38 58 L24 68 L38 78"/></g>`;
}

export interface DieOpts {
  size?: number;
  obliterated?: boolean;
  variant?: 'standard' | 'noModifier';
  title?: string;
}

/** The pip count shown on a face: its bonus to its own ability. */
function pipCount(die: Ability, side: number, variant: string): number {
  if (variant === 'noModifier') return side;
  if (die === 'physical') return [0, 1, 2, 2, 3, 4, 1][side] ?? side;
  return [0, 1, 2, 3, 4, 1, 1][side] ?? side;
}

export function dieSvg(die: Ability, side: number, opts: DieOpts = {}): string {
  const size = opts.size ?? 40;
  const color = DIE_COLOR[die];
  const variant = opts.variant ?? 'standard';
  let glyph: string;
  if (variant === 'standard' && side === 6) glyph = obliterateGlyph(color);
  else {
    const n = pipCount(die, side, variant);
    glyph = (PIPS[n] ?? []).map(([x, y]) => `<circle cx="${x}" cy="${y}" r="8.5" fill="${color}"/>`).join('');
    if (variant === 'standard' && die !== 'physical' && side === 1) glyph += rerollGlyph(color);
    if (variant === 'standard' && die !== 'physical' && side === 5) glyph += `<circle cx="78" cy="78" r="6" fill="${DIE_COLOR.physical}" stroke="#0b1220" stroke-width="2"/>`;
  }
  const strike = opts.obliterated ? `<path d="M14 14 L86 86 M86 14 L14 86" stroke="#ff4d6d" stroke-width="7" stroke-linecap="round" opacity="0.9"/>` : '';
  const label = opts.title ?? `${die} die, side ${side}${opts.obliterated ? ', destroyed' : ''}`;
  return `<svg class="die die-${die}${opts.obliterated ? ' obliterated' : ''}" width="${size}" height="${size}" viewBox="0 0 100 100" role="img" aria-label="${label}">
    <title>${label}</title>
    <rect x="4" y="4" width="92" height="92" rx="18" fill="#141d2e" stroke="${color}" stroke-width="4"/>
    <rect x="10" y="10" width="80" height="80" rx="13" fill="none" stroke="rgba(255,255,255,0.07)" stroke-width="2"/>
    ${glyph}${strike}</svg>`;
}
