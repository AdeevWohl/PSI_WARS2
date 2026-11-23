/**
 * SFX hooks and mixer (§6.7). No audio assets were supplied: each hook maps to an optional
 * file in AUDIO_FILES (drop files in public/audio and list them — a data change), and until
 * then a short synthesized placeholder plays so the mixer and sliders are testable.
 */
import { settings } from './settings';

export type Sfx =
  | 'draw' | 'play' | 'cuDeplete' | 'dice' | 'obliterate' | 'disorient' | 'destroy' | 'labHit' | 'trap' | 'victory' | 'defeat' | 'click' | 'phase';

/** Real files go here, e.g. { draw: 'audio/draw.ogg' }. */
export const AUDIO_FILES: Partial<Record<Sfx, string>> = {};

const SYNTH: Record<Sfx, { f: number; f2?: number; dur: number; type: OscillatorType; gain: number }> = {
  draw: { f: 660, f2: 880, dur: 0.08, type: 'triangle', gain: 0.25 },
  play: { f: 300, f2: 180, dur: 0.14, type: 'sine', gain: 0.4 },
  cuDeplete: { f: 1200, dur: 0.03, type: 'square', gain: 0.12 },
  dice: { f: 180, f2: 420, dur: 0.18, type: 'sawtooth', gain: 0.12 },
  obliterate: { f: 90, f2: 40, dur: 0.4, type: 'sawtooth', gain: 0.35 },
  disorient: { f: 520, f2: 260, dur: 0.3, type: 'sine', gain: 0.25 },
  destroy: { f: 140, f2: 50, dur: 0.35, type: 'square', gain: 0.25 },
  labHit: { f: 70, f2: 45, dur: 0.3, type: 'sine', gain: 0.5 },
  trap: { f: 900, f2: 300, dur: 0.35, type: 'triangle', gain: 0.22 },
  victory: { f: 440, f2: 880, dur: 0.9, type: 'triangle', gain: 0.3 },
  defeat: { f: 300, f2: 110, dur: 0.9, type: 'sine', gain: 0.3 },
  click: { f: 1500, dur: 0.02, type: 'square', gain: 0.06 },
  phase: { f: 520, f2: 640, dur: 0.12, type: 'sine', gain: 0.12 },
};

let ctx: AudioContext | null = null;
const buffers = new Map<string, AudioBuffer>();

function audio(): AudioContext | null {
  if (ctx) return ctx;
  try {
    ctx = new AudioContext();
  } catch {
    ctx = null;
  }
  return ctx;
}

export function sfxVolume(): number {
  const s = settings();
  return s.volMaster * s.volSfx;
}

export function playSfx(name: Sfx): void {
  const vol = sfxVolume();
  if (vol <= 0.001) return;
  const ac = audio();
  if (!ac || ac.state === 'suspended') {
    void ac?.resume().catch(() => {});
    if (!ac || ac.state === 'suspended') return;
  }
  const file = AUDIO_FILES[name];
  if (file) {
    void playFile(ac, file, vol);
    return;
  }
  if (!settings().placeholderSounds) return;
  const spec = SYNTH[name];
  const t = ac.currentTime;
  const osc = ac.createOscillator();
  const g = ac.createGain();
  osc.type = spec.type;
  osc.frequency.setValueAtTime(spec.f, t);
  if (spec.f2) osc.frequency.exponentialRampToValueAtTime(spec.f2, t + spec.dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(spec.gain * vol, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + spec.dur);
  osc.connect(g).connect(ac.destination);
  osc.start(t);
  osc.stop(t + spec.dur + 0.02);
}

async function playFile(ac: AudioContext, url: string, vol: number): Promise<void> {
  let buf = buffers.get(url);
  if (!buf) {
    try {
      const r = await fetch(url);
      buf = await ac.decodeAudioData(await r.arrayBuffer());
      buffers.set(url, buf);
    } catch {
      return;
    }
  }
  const src = ac.createBufferSource();
  const g = ac.createGain();
  g.gain.value = vol;
  src.buffer = buf;
  src.connect(g).connect(ac.destination);
  src.start();
}

/** Browsers require a user gesture before audio: unlock on the first interaction. */
export function unlockAudioOnGesture(): void {
  const unlock = () => {
    void audio()?.resume().catch(() => {});
    window.removeEventListener('pointerdown', unlock);
    window.removeEventListener('keydown', unlock);
  };
  window.addEventListener('pointerdown', unlock);
  window.addEventListener('keydown', unlock);
}
