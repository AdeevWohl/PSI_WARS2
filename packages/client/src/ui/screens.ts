/** Title, main menu, hot-seat setup. */
import type { Seat } from '@psi-wars/shared';
import { artUrl, preload } from '../assets';
import { currentDefs, rules, starterDecks, type StoredDeck } from '../data';
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

export function mainMenu(items: MenuItem[]): HTMLElement {
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
    ),
  );
}

export interface SeatSetup {
  name: string;
  deck: StoredDeck;
}

export interface HotseatConfig {
  seats: SeatSetup[];
  startingHP: number;
  diceVariant: 'standard' | 'noModifier';
}

/** Hot-seat: names, decks, starting HP; preloads this match's art with a progress bar. */
export function hotseatSetup(onStart: (cfg: HotseatConfig) => void, onBack: () => void): HTMLElement {
  const decks = starterDecks;
  const seats: SeatSetup[] = [
    { name: 'Player 1', deck: decks[0]! },
    { name: 'Player 2', deck: decks[1]! },
  ];
  let hp = rules.setup.startingHP.default;
  let dice: 'standard' | 'noModifier' = 'standard';
  const progress = h('div', { class: 'progress' }, h('div', { class: 'progress-fill' }));
  const progressLabel = h('div', { class: 'dim', style: 'font-size:13px;min-height:18px' });

  const seatCard = (s: SeatSetup, i: Seat) =>
    h('div', { class: 'seat-card panel' },
      h('label', { class: 'field-label' }, `Player ${i + 1} name`),
      h('input', { class: 'text-input', value: s.name, maxlength: '20', oninput: (e: Event) => (s.name = (e.target as HTMLInputElement).value || `Player ${i + 1}`) }),
      h('label', { class: 'field-label' }, 'Deck'),
      h('select', { class: 'text-input', onchange: (e: Event) => (s.deck = decks.find((d) => d.id === (e.target as HTMLSelectElement).value)!) },
        ...decks.map((d) => h('option', { value: d.id, selected: d.id === s.deck.id ? true : undefined }, d.name))),
    );

  const hpSel = h('select', { class: 'text-input', onchange: (e: Event) => (hp = Number((e.target as HTMLSelectElement).value)) },
    ...Array.from({ length: rules.setup.startingHP.max - rules.setup.startingHP.min + 1 }, (_, k) => rules.setup.startingHP.min + k).map((v) =>
      h('option', { value: String(v), selected: v === hp ? true : undefined }, v === 10 ? '10 — short (~30 min)' : v === 15 ? '15 — default' : v === 20 ? '20 — long (45–60 min)' : String(v))));
  const diceSel = h('select', { class: 'text-input', onchange: (e: Event) => (dice = (e.target as HTMLSelectElement).value as any) },
    h('option', { value: 'standard' }, 'Standard dice'),
    h('option', { value: 'noModifier' }, 'No modifier dice (each die gives +1…+6)'));

  const start = h('button', { class: 'btn primary', style: 'font-size:18px;padding:12px 34px' }, 'Start game');
  start.addEventListener('click', async () => {
    start.setAttribute('disabled', '');
    const defs = currentDefs();
    const ids = new Set<string>();
    for (const s of seats) for (const id of [...Object.keys(s.deck.battle), ...Object.keys(s.deck.resource)]) ids.add(id);
    const urls: string[] = ['backs/battle', 'backs/resource'].flatMap((k) => [artUrl(k, 'sm')!]);
    for (const id of ids) {
      const a = defs[id]?.art;
      for (const sz of ['sm', 'md'] as const) {
        const u = artUrl(a, sz);
        if (u) urls.push(u);
      }
    }
    await preload(urls, (d, t) => {
      (progress.firstChild as HTMLElement).style.transform = `scaleX(${t ? d / t : 1})`;
      progressLabel.textContent = `Preparing card art… ${d} / ${t}`;
    });
    onStart({ seats, startingHP: hp, diceVariant: dice });
  });

  return h(
    'div',
    { class: 'screen setup-screen' },
    h('div', { class: 'menu-bg' }),
    h('div', { class: 'setup-panel panel' },
      h('h2', { class: 'h-display' }, 'Hot-seat game'),
      h('p', { class: 'dim' }, 'Two players share this device. A curtain hides the screen whenever the turn passes, so each player only sees their own hand.'),
      h('div', { class: 'seat-row' }, ...seats.map((s, i) => seatCard(s, i))),
      h('div', { class: 'opt-row' },
        h('div', null, h('label', { class: 'field-label' }, 'Starting Lab HP'), hpSel),
        h('div', null, h('label', { class: 'field-label' }, 'Dice'), diceSel)),
      progress, progressLabel,
      h('div', { class: 'row' }, h('button', { class: 'btn', onclick: onBack }, 'Back'), start),
    ),
  );
}
