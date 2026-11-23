/** Title, main menu, hot-seat setup. */
import type { Seat } from '@psi-wars/shared';
import { artUrl, preload } from '../assets';
import { currentDefs, rules, starterDecks, type StoredDeck } from '../data';
import { settings } from '../settings';
import { playableDecks } from '../decks';
import { h } from './dom';

export function titleScreen(onContinue: () => void): HTMLElement {
  const logo = artUrl('ui/logo', 'md');
  const go = () => {
    document.removeEventListener('keydown', go);
    onContinue();
  };
  document.addEventListener('keydown', go);
  return h(
    'div',
    { class: 'screen title-screen', onclick: go },
    h('div', { class: 'menu-bg' }),
    h('div', { class: 'title-inner' },
      logo ? h('img', { class: 'title-logo', src: logo, alt: 'Psi Wars logo' }) : null,
      h('h1', { class: 'title-name' }, 'PSI WARS'),
      h('p', { class: 'title-tag' }, 'Rules for Planetary Domination'),
      h('button', { class: 'btn primary title-go', onclick: go }, 'Press any key'),
    ),
  );
}

export interface MenuItem {
  label: string;
  sub: string;
  onClick?: () => void;
  disabledReason?: string;
}

export function mainMenu(items: MenuItem[], footer: (HTMLElement | null)[] = []): HTMLElement {
  const logo = artUrl('ui/logo', 'sm');
  return h(
    'div',
    { class: 'screen menu-screen' },
    h('div', { class: 'menu-bg' }),
    h('nav', { class: 'menu-panel panel', 'aria-label': 'Main menu' },
      h('div', { class: 'menu-head' }, logo ? h('img', { src: logo, alt: '' }) : null, h('div', { class: 'h-display', style: 'font-size:30px' }, 'Psi Wars')),
      ...items.map((it) =>
        h('button', { class: 'menu-item', disabled: !!it.disabledReason, title: it.disabledReason, onclick: it.onClick },
          h('span', { class: 'mi-label' }, it.label),
          h('span', { class: 'mi-sub' }, it.disabledReason ?? it.sub)),
      ),
      ...footer,
    ),
  );
}

export type SeatKindChoice = 'human' | 'easy' | 'normal' | 'hard';

export interface LocalSeat {
  kind: SeatKindChoice;
  name: string;
  deck: StoredDeck;
}

export interface LocalConfig {
  seats: LocalSeat[];
  startingHP: number;
  diceVariant: 'standard' | 'noModifier';
}

const KIND_LABEL: Record<SeatKindChoice, string> = { human: 'Human', easy: 'Computer — Easy', normal: 'Computer — Normal', hard: 'Computer — Hard' };
const SEAT_COLORS = ['#4fd1ff', '#ff8a4c', '#c77dff', '#5ee6a8'];

/**
 * One setup screen for every local game: 2–4 seats, each a human at this device or a
 * computer player, in any mix (§4.1 "any mix of humans and AI"). Two presets:
 * "vsai" starts as you vs one computer; "hotseat" as two humans sharing the device.
 */
export function localSetup(preset: 'vsai' | 'hotseat', onStart: (cfg: LocalConfig) => void, onBack: () => void): HTMLElement {
  const decks = playableDecks();
  const seats: LocalSeat[] =
    preset === 'vsai'
      ? [{ kind: 'human', name: 'You', deck: decks[0]! }, { kind: 'normal', name: 'Computer', deck: decks[1]! }]
      : [{ kind: 'human', name: 'Player 1', deck: decks[0]! }, { kind: 'human', name: 'Player 2', deck: decks[1]! }];
  const cfg: LocalConfig = { seats, startingHP: settings().startingHP ?? rules.setup.startingHP.default, diceVariant: settings().diceVariant };
  const list = h('div', { class: 'local-seats' });
  const note = h('p', { class: 'dim', style: 'font-size:14px;min-height:20px' });
  const sel = (opts: [string, string][], value: string, on: (v: string) => void, label: string) =>
    h('select', { class: 'text-input', 'aria-label': label, onchange: (e: Event) => on((e.target as HTMLSelectElement).value) }, ...opts.map(([v, l]) => h('option', { value: v, selected: v === value ? true : undefined }, l)));

  const renderSeats = () => {
    list.replaceChildren(
      ...seats.map((s, i) =>
        h('div', { class: 'local-seat panel', style: { '--seat-color': SEAT_COLORS[i] } as any },
          h('span', { class: 'seat-dot' }),
          h('div', { class: 'local-seat-fields' },
            h('input', { class: 'text-input', value: s.name, maxlength: '20', 'aria-label': `Seat ${i + 1} name`, oninput: (e: Event) => (s.name = (e.target as HTMLInputElement).value) }),
            sel((Object.keys(KIND_LABEL) as SeatKindChoice[]).map((k) => [k, KIND_LABEL[k]]), s.kind, (v) => {
              const was = s.kind;
              s.kind = v as SeatKindChoice;
              if ((was === 'human') !== (s.kind === 'human')) s.name = s.kind === 'human' ? `Player ${i + 1}` : 'Computer';
              renderSeats();
            }, `Seat ${i + 1} player type`),
            sel(decks.map((d) => [d.id, d.name]), s.deck.id, (v) => (s.deck = decks.find((d) => d.id === v)!), `Seat ${i + 1} deck`)),
          seats.length > 2 ? h('button', { class: 'btn small ghost', 'aria-label': `Remove seat ${i + 1}`, onclick: () => { seats.splice(i, 1); renderSeats(); } }, '✕') : null)),
      ...(seats.length < 4
        ? [h('button', { class: 'btn ghost add-seat', onclick: () => { seats.push({ kind: 'normal', name: 'Computer', deck: decks[seats.length % decks.length]! }); renderSeats(); } }, '+ Add a seat (up to 4)')]
        : []),
    );
    const humans = seats.filter((s) => s.kind === 'human').length;
    note.textContent =
      humans === 0 ? 'All seats are computers: you will watch them play.'
      : humans > 1 ? `${humans} people share this device. A curtain hides the screen whenever play passes between them.`
      : seats.length > 2 ? 'Free-for-all: each of your attackers picks which opponent it attacks. Last player standing wins.'
      : '';
  };
  renderSeats();

  const progress = h('div', { class: 'progress' }, h('div', { class: 'progress-fill' }));
  const progressLabel = h('div', { class: 'dim', style: 'font-size:13px;min-height:18px' });
  const start = h('button', { class: 'btn primary', style: 'font-size:18px;padding:12px 34px' }, 'Start game');
  start.addEventListener('click', async () => {
    start.setAttribute('disabled', '');
    const defs = currentDefs();
    const urls = new Set<string>([artUrl('backs/battle', 'sm')!, artUrl('backs/resource', 'sm')!]);
    for (const s of seats) for (const id of [...Object.keys(s.deck.battle), ...Object.keys(s.deck.resource)]) for (const sz of ['sm', 'md'] as const) { const u = artUrl(defs[id]?.art, sz); if (u) urls.add(u); }
    await preload([...urls], (d, t) => {
      (progress.firstChild as HTMLElement).style.transform = `scaleX(${t ? d / t : 1})`;
      progressLabel.textContent = `Preparing card art… ${d} / ${t}`;
    });
    seats.forEach((s, i) => (s.name = s.name.trim() || (s.kind === 'human' ? `Player ${i + 1}` : 'Computer')));
    onStart({ ...cfg, seats: seats.map((s) => ({ ...s })) });
  });

  return h('div', { class: 'screen setup-screen' },
    h('div', { class: 'menu-bg' }),
    h('div', { class: 'setup-panel panel' },
      h('h2', { class: 'h-display' }, preset === 'vsai' ? 'Play vs AI' : 'Hot-seat game'),
      h('p', { class: 'dim' }, 'Two to four seats, each a person at this device or a computer player. Computers only see what their own seat can see.'),
      list,
      note,
      h('div', { class: 'opt-row' },
        h('div', null, h('label', { class: 'field-label' }, 'Starting Lab HP'), sel(Array.from({ length: 11 }, (_, k) => [String(10 + k), 10 + k === 15 ? '15 — default' : String(10 + k)] as [string, string]), String(cfg.startingHP), (v) => (cfg.startingHP = Number(v)), 'Starting Lab HP')),
        h('div', null, h('label', { class: 'field-label' }, 'Dice'), sel([['standard', 'Standard dice'], ['noModifier', 'No modifier dice (each die gives +1…+6)']], cfg.diceVariant, (v) => (cfg.diceVariant = v as LocalConfig['diceVariant']), 'Dice'))),
      progress, progressLabel,
      h('div', { class: 'row' }, h('button', { class: 'btn', onclick: onBack }, 'Back'), start)));
}

export type { Seat };
