/**
 * Settings (build prompt §7): one model, persisted to localStorage, applied live with no restart.
 * Presentation settings become CSS variables / data attributes and timeline parameters.
 */
export type Speed = 'instant' | 'fast' | 'normal' | 'cinematic';
export type Level3 = 'off' | 'subtle' | 'full';

export interface Settings {
  // Presentation — effects
  speed: Speed;
  flip3d: boolean;
  glow: 'off' | 'subtle' | 'full';
  shadows: 'off' | 'simple' | 'soft';
  particles: 'off' | 'reduced' | 'full';
  shake: Level3;
  dice: '3d' | '2d' | 'instant';
  reducedMotion: boolean;
  // Presentation — other
  zoomOnHover: boolean;
  zoomSize: number;
  boardBrightness: number;
  alwaysChips: boolean;
  uiScale: number;
  colorblind: boolean;
  // Audio
  volMaster: number;
  volMusic: number;
  volSfx: number;
  placeholderSounds: boolean;
  // Gameplay
  startingHP: number;
  diceVariant: 'standard' | 'noModifier';
  autoPass: boolean;
  trapWindowSec: number;
  fastWindows: boolean;
  turnTimer: 0 | 30 | 60 | 120;
  confirmEndPhase: boolean;
  logVerbosity: 'brief' | 'normal' | 'full';
  // Accessibility
  fontScale: number;
  highContrast: boolean;
}

export const SPEED_FACTOR: Record<Speed, number> = { instant: 0, fast: 0.6, normal: 1, cinematic: 1.6 };

const prefersReduced = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export const DEFAULTS: Settings = {
  speed: prefersReduced ? 'instant' : 'normal',
  flip3d: true,
  glow: 'full',
  shadows: 'soft',
  particles: prefersReduced ? 'off' : 'full',
  shake: prefersReduced ? 'off' : 'subtle',
  dice: prefersReduced ? 'instant' : '3d',
  reducedMotion: prefersReduced,
  zoomOnHover: true,
  zoomSize: 330,
  boardBrightness: 1,
  alwaysChips: false,
  uiScale: 1,
  colorblind: false,
  volMaster: 0.8,
  volMusic: 0.5,
  volSfx: 0.8,
  placeholderSounds: true,
  startingHP: 15,
  diceVariant: 'standard',
  autoPass: true,
  trapWindowSec: 3,
  fastWindows: false,
  turnTimer: 0,
  confirmEndPhase: false,
  logVerbosity: 'normal',
  fontScale: 1,
  highContrast: false,
};

export const PRESETS: Record<'performance' | 'quality', Partial<Settings>> = {
  performance: { speed: 'instant', particles: 'off', shake: 'off', shadows: 'simple', glow: 'subtle', dice: 'instant', flip3d: false },
  quality: { speed: 'cinematic', particles: 'full', shake: 'full', shadows: 'soft', glow: 'full', dice: '3d', flip3d: true, reducedMotion: false },
};

const KEY = 'psiwars.settings';
type Listener = (s: Settings) => void;
const listeners = new Set<Listener>();

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    /* private mode / blocked storage: defaults */
  }
  return { ...DEFAULTS };
}

let current: Settings = load();

export function settings(): Settings {
  return current;
}

export function updateSettings(patch: Partial<Settings>, persist = true): void {
  current = { ...current, ...patch };
  if (patch.reducedMotion === true) current = { ...current, speed: 'instant', particles: 'off', shake: 'off', dice: 'instant' };
  if (persist) {
    try {
      localStorage.setItem(KEY, JSON.stringify(current));
    } catch {
      /* ignore */
    }
  }
  applySettings();
  for (const l of listeners) l(current);
}

export function resetSettings(): void {
  current = { ...DEFAULTS };
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
  applySettings();
  for (const l of listeners) l(current);
}

export function onSettings(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Effective animation speed factor (0 = instant). */
export function speedFactor(): number {
  return current.reducedMotion ? 0 : SPEED_FACTOR[current.speed];
}

export function applySettings(): void {
  const root = document.documentElement;
  const s = current;
  root.style.setProperty('--speed', String(Math.max(speedFactor(), 0.001)));
  root.style.setProperty('--board-brightness', String(s.boardBrightness));
  root.style.setProperty('--font-scale', String(s.fontScale));
  root.dataset.glow = s.glow;
  root.dataset.shadows = s.shadows;
  root.dataset.cb = s.colorblind ? 'on' : 'off';
  root.dataset.contrast = s.highContrast ? 'high' : 'normal';
  root.dataset.flip = s.flip3d ? '3d' : 'fade';
  root.dataset.motion = speedFactor() === 0 ? 'none' : 'on';
  window.dispatchEvent(new Event('resize')); // re-fit the stage for UI scale
}
