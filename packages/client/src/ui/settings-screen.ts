/** Settings screen (§7): grouped, applies live, persisted. Used full-screen and as an in-game modal. */
import { playSfx } from '../audio';
import { PRESETS, resetSettings, settings, updateSettings, type Settings } from '../settings';
import { h } from './dom';

type Opt<T> = { value: T; label: string };

function row(label: string, control: HTMLElement, hint?: string): HTMLElement {
  const id = `set-${label.replace(/\W+/g, '-').toLowerCase()}`;
  // Label the actual form control (range sliders come wrapped with their value readout).
  const target = control.matches('input, select, textarea') ? control : (control.querySelector('input, select, textarea') as HTMLElement | null) ?? control;
  target.id = id;
  return h('div', { class: 'set-row' }, h('label', { for: id, class: 'set-label' }, label, hint ? h('span', { class: 'set-hint' }, hint) : null), control);
}

function select<K extends keyof Settings>(key: K, opts: Opt<Settings[K]>[]): HTMLElement {
  const el = h('select', { class: 'text-input small', onchange: (e: Event) => {
    const raw = (e.target as HTMLSelectElement).value;
    const o = opts.find((x) => String(x.value) === raw);
    if (o) updateSettings({ [key]: o.value } as Partial<Settings>);
  } }, ...opts.map((o) => h('option', { value: String(o.value), selected: settings()[key] === o.value ? true : undefined }, o.label)));
  return el;
}

function toggle<K extends keyof Settings>(key: K): HTMLElement {
  const input = h('input', { type: 'checkbox', class: 'toggle', checked: settings()[key] ? true : undefined, onchange: (e: Event) => updateSettings({ [key]: (e.target as HTMLInputElement).checked } as Partial<Settings>) });
  return input;
}

function range<K extends keyof Settings>(key: K, min: number, max: number, step: number, fmt: (v: number) => string, after?: () => void): HTMLElement {
  const out = h('span', { class: 'range-val' }, fmt(Number(settings()[key])));
  const input = h('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(settings()[key]), oninput: (e: Event) => {
    const v = Number((e.target as HTMLInputElement).value);
    out.textContent = fmt(v);
    updateSettings({ [key]: v } as Partial<Settings>);
  }, onchange: () => after?.() });
  return h('span', { class: 'range-wrap' }, input, out);
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

export function settingsPanel(onClose?: () => void): HTMLElement {
  const body = h('div', { class: 'settings-body' });
  const build = () => {
    body.replaceChildren(
      h('section', { class: 'set-group' },
        h('h3', null, 'Presentation — effects'),
        h('div', { class: 'preset-row' },
          h('button', { class: 'btn small', onclick: () => { updateSettings(PRESETS.performance); build(); } }, 'Performance preset'),
          h('button', { class: 'btn small', onclick: () => { updateSettings(PRESETS.quality); build(); } }, 'Quality preset')),
        row('Animation speed', select('speed', [{ value: 'instant', label: 'Instant' }, { value: 'fast', label: 'Fast' }, { value: 'normal', label: 'Normal' }, { value: 'cinematic', label: 'Cinematic' }])),
        row('3D card flip', toggle('flip3d'), 'off = cross-fade'),
        row('Glow', select('glow', [{ value: 'off', label: 'Off' }, { value: 'subtle', label: 'Subtle' }, { value: 'full', label: 'Full' }])),
        row('Shadows', select('shadows', [{ value: 'off', label: 'Off' }, { value: 'simple', label: 'Simple' }, { value: 'soft', label: 'Soft' }])),
        row('Particles & screen effects', select('particles', [{ value: 'off', label: 'Off' }, { value: 'reduced', label: 'Reduced' }, { value: 'full', label: 'Full' }])),
        row('Screen shake', select('shake', [{ value: 'off', label: 'Off' }, { value: 'subtle', label: 'Subtle' }, { value: 'full', label: 'Full' }])),
        row('Dice', select('dice', [{ value: '3d', label: '3D' }, { value: '2d', label: '2D flip' }, { value: 'instant', label: 'Instant result' }])),
        row('Showcase played cards', select('showcase', [{ value: 'on', label: 'All cards' }, { value: 'opponents', label: "Opponents' cards only" }, { value: 'off', label: 'Off' }]), 'a played card is shown large in the middle first'),
        row('Battle spotlight', toggle('spotlight'), 'each battle is shown big in the centre, step by step'),
        row('Hold time', select('holdTime', [{ value: 'short', label: 'Short' }, { value: 'normal', label: 'Normal' }, { value: 'long', label: 'Long' }]), 'pause after each action so you can read what happened'),
        row('Reduced motion', toggle('reducedMotion'), 'master switch: instant animations, no particles or shake'),
      ),
      h('section', { class: 'set-group' },
        h('h3', null, 'Presentation — other'),
        row('Card zoom on hover', toggle('zoomOnHover')),
        row('Zoom size', range('zoomSize', 220, 440, 10, (v) => `${v}px`)),
        row('Board brightness', range('boardBrightness', 0.6, 1.25, 0.05, pct)),
        row('Always show stat chips', toggle('alwaysChips'), 'otherwise only when a value differs from the printed card'),
        row('UI scale', range('uiScale', 0.8, 1.2, 0.05, pct)),
        row('Auto-reduce effects when slow', toggle('autoReduce'), 'switches to the Performance preset if game animations stay below ~40 fps'),
                row('Colourblind-safe mode', toggle('colorblind'), 'adds shapes/arrows to ability and Creation Unit colours'),
      ),
      h('section', { class: 'set-group' },
        h('h3', null, 'Audio'),
        row('Master volume', range('volMaster', 0, 1, 0.05, pct, () => playSfx('click'))),
        row('Music volume', range('volMusic', 0, 1, 0.05, pct), 'no music supplied yet'),
        row('Effects volume', range('volSfx', 0, 1, 0.05, pct, () => playSfx('play'))),
        row('Placeholder sounds', toggle('placeholderSounds'), 'synthesized beeps until real audio files are added'),
      ),
      h('section', { class: 'set-group' },
        h('h3', null, 'Gameplay'),
        row('Default starting Lab HP', range('startingHP', 10, 20, 1, (v) => String(v))),
        row('Dice variant', select('diceVariant', [{ value: 'standard', label: 'Standard' }, { value: 'noModifier', label: 'No modifier dice' }])),
        row('Auto-pass when no legal Power play', toggle('autoPass'), 'hot-seat and solo games'),
        row('Trap response window', range('trapWindowSec', 0, 10, 1, (v) => `${v} s`), 'online games'),
        row('Fast windows', toggle('fastWindows'), 'skips players with no legal play — faster, but a pause then reveals that someone holds a Trap'),
        row('Turn timer', select('turnTimer', [{ value: 0, label: 'Off' }, { value: 30, label: '30 s' }, { value: 60, label: '60 s' }, { value: 120, label: '120 s' }])),
        row('Confirm before ending a phase', toggle('confirmEndPhase')),
        row('Battle log detail', select('logVerbosity', [{ value: 'brief', label: 'Brief' }, { value: 'normal', label: 'Normal' }, { value: 'full', label: 'Full' }])),
      ),
      h('section', { class: 'set-group' },
        h('h3', null, 'Accessibility'),
        row('Font size', range('fontScale', 0.9, 1.3, 0.05, pct), 'all interface text; card faces keep their printed text'),
        row('High contrast', toggle('highContrast')),
        h('p', { class: 'dim', style: 'font-size:13px' }, 'Every control is keyboard-reachable (Tab, Space/Enter, Esc). Cards and controls carry screen-reader labels.'),
      ),
    );
  };
  build();
  return h('div', { class: 'settings-panel' },
    body,
    h('div', { class: 'row settings-actions' },
      h('button', { class: 'btn', onclick: () => { resetSettings(); build(); } }, 'Reset to defaults'),
      onClose ? h('button', { class: 'btn primary', onclick: onClose }, 'Done') : null),
  );
}
