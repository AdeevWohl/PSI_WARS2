import './styles/tokens.css';
import './styles/base.css';
import './styles/card.css';
import './styles/board.css';
import './styles/screens.css';
import './styles/anim.css';
import { artUrl, loadManifest } from './assets';
import { unlockAudioOnGesture } from './audio';
import { PerfMonitor } from './anim/perf';
import { currentDefs, rules } from './data';
import { LocalGame, randomSeed } from './game/local';
import { applySettings, settings, updateSettings } from './settings';
import { h } from './ui/dom';
import { GameScreen } from './ui/game-screen';
import { openModal } from './ui/modals';
import { hotseatSetup, mainMenu, titleScreen, vsAiSetup, type HotseatConfig, type VsAiConfig } from './ui/screens';
import { settingsPanel } from './ui/settings-screen';

const stage = document.getElementById('stage')!;
let current: { el: HTMLElement; destroy?: () => void } | null = null;
const perf = new PerfMonitor();

function fitStage(): void {
  const s = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
  stage.style.transform = `translate(-50%, -50%) scale(${s * settings().uiScale})`;
}
window.addEventListener('resize', fitStage);

function show(el: HTMLElement, destroy?: () => void): void {
  current?.destroy?.();
  current?.el.remove();
  current = { el, destroy };
  stage.prepend(el);
}

function openSettingsModal(host: HTMLElement): void {
  let m: ReturnType<typeof openModal>;
  m = openModal(host, 'Settings', 'Changes apply immediately.', settingsPanel(() => m.close()), [], { dismissable: true, className: 'settings-modal' });
}

function toMenu(): void {
  show(
    mainMenu([
      { label: 'Play vs AI', sub: 'You against the computer: Easy, Normal or Hard', onClick: () => show(vsAiSetup((cfg) => startVsAi(cfg), () => toMenu())) },
      { label: 'Host Game', sub: 'Online room with a code', disabledReason: 'Arrives in Stage 5 (online play)' },
      { label: 'Join Game', sub: 'Enter a room code', disabledReason: 'Arrives in Stage 5 (online play)' },
      { label: 'Hot-seat', sub: 'Two players, one device, hidden-hand curtains', onClick: () => toHotseat() },
      { label: 'Deck Builder', sub: 'Build and save decks', disabledReason: 'Arrives in Stage 7' },
      { label: 'How to Play', sub: 'Rules reference and tutorial', disabledReason: 'Arrives in Stage 7' },
      { label: 'Settings', sub: 'Animation, effects, audio, gameplay, accessibility', onClick: () => toSettings() },
    ]),
  );
}

function toSettings(): void {
  show(h('div', { class: 'screen settings-screen' }, h('div', { class: 'menu-bg' }), h('div', { class: 'settings-page panel' }, h('h2', { class: 'h-display' }, 'Settings'), settingsPanel(() => toMenu()))));
}

function toHotseat(): void {
  show(hotseatSetup((cfg) => startHotseat(cfg), () => toMenu()));
}

function startHotseat(cfg: HotseatConfig): void {
  const game = new LocalGame(
    cfg.seats.map((s, seat) => ({ seat, name: s.name, kind: 'local' as const })),
    {
      defs: currentDefs(),
      rules,
      seed: randomSeed(),
      players: cfg.seats.map((s) => ({ name: s.name, deck: s.deck })),
      startingHP: cfg.startingHP,
      diceVariant: cfg.diceVariant,
      autoPassNoPlay: settings().autoPass,
    },
  );
  const screen = new GameScreen(game, game.initialEvents(), {
    onExit: () => toMenu(),
    onRematch: () => startHotseat(cfg),
    openSettings: (host) => openSettingsModal(host),
  });
  show(screen.el, () => {
    screen.destroy();
    game.dispose();
  });
  (window as any).__psi = { game, screen, perf };
}

function startVsAi(cfg: VsAiConfig): void {
  const level = cfg.level[0]!.toUpperCase() + cfg.level.slice(1);
  const game = new LocalGame(
    [
      { seat: 0, name: cfg.name, kind: 'local' },
      { seat: 1, name: `Computer (${level})`, kind: 'ai', aiLevel: cfg.level },
    ],
    {
      defs: currentDefs(),
      rules,
      seed: randomSeed(),
      players: [{ name: cfg.name, deck: cfg.deck }, { name: `Computer (${level})`, deck: cfg.aiDeck }],
      startingHP: cfg.startingHP,
      diceVariant: cfg.diceVariant,
      autoPassNoPlay: settings().autoPass,
    },
  );
  const screen = new GameScreen(game, game.initialEvents(), {
    onExit: () => toMenu(),
    onRematch: () => startVsAi(cfg),
    openSettings: (host) => openSettingsModal(host),
  });
  show(screen.el, () => {
    screen.destroy();
    game.dispose();
  });
  (window as any).__psi = { game, screen, perf };
}

async function boot(): Promise<void> {
  applySettings();
  fitStage();
  unlockAudioOnGesture();
  perf.start();
  await loadManifest();
  const bg = artUrl('ui/menu-bg', '1920');
  if (bg) document.documentElement.style.setProperty('--menu-bg-url', `url("${bg}")`);
  show(titleScreen(() => toMenu()));
}

stage.appendChild(h('div', { id: 'toasts' }));
(window as any).__psiSettings = { settings, updateSettings };
void boot();
