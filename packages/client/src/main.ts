import './styles/tokens.css';
import './styles/base.css';
import './styles/card.css';
import './styles/board.css';
import './styles/screens.css';
import './styles/anim.css';
import { artUrl, loadManifest } from './assets';
import { unlockAudioOnGesture } from './audio';
import { PerfMonitor } from './anim/perf';
import { currentDefs, rules, starterDecks } from './data';
import { LocalGame, randomSeed } from './game/local';
import { applySettings, settings, updateSettings } from './settings';
import { h, toast } from './ui/dom';
import { createRoom, RemoteGame } from './net/remote';
import { LobbyScreen, deckPayload, onlineEntry } from './ui/lobby';
import type { StoredDeck } from './data';
import { GameScreen } from './ui/game-screen';
import { openModal } from './ui/modals';
import { DeckBuilder } from './ui/deckbuilder';
import { playableDecks } from './decks';
import { localSetup, mainMenu, titleScreen, type LocalConfig } from './ui/screens';
import { settingsPanel } from './ui/settings-screen';
import { rulesReference } from './ui/rules';
import { Tutorial } from './ui/tutorial';
import tutorialCfg from '@data/tutorial.json';
import { checkLog } from '@psi-wars/engine';
import { activeBalance, setActiveBalance } from './balance';
import { CardEditor } from './ui/card-editor';
import { ReplayViewer, pickLogFile } from './ui/replay';

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

/** Developer mode (build prompt §13): the balance tools live behind Ctrl+Shift+D or ?dev, not the main menu. */
function devMode(): boolean {
  try {
    return localStorage.getItem('psiwars.dev') === '1';
  } catch {
    return false;
  }
}
function setDevMode(on: boolean): void {
  try {
    if (on) localStorage.setItem('psiwars.dev', '1');
    else localStorage.removeItem('psiwars.dev');
  } catch {
    /* ignore */
  }
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

function menuFooter(): (HTMLElement | null)[] {
  const b = activeBalance();
  return [
    b ? h('div', { class: 'menu-balance', role: 'status' },
      h('span', null, 'Custom card balance: ', h('b', null, b.name), ` (${plural(Object.keys(b.cards).length, 'card')} changed)`),
      h('button', { class: 'btn small ghost', onclick: () => { setActiveBalance(null); toast('Standard cards restored.'); toMenu(); } }, 'Use standard cards')) : null,
    devMode() ? h('button', { class: 'menu-dev-link', onclick: () => toDev() }, 'Developer tools (Ctrl+Shift+D)') : null,
  ];
}

function toDev(): void {
  setDevMode(true);
  const b = activeBalance();
  const item = (label: string, sub: string, onClick: () => void) => h('button', { class: 'menu-item', onclick: onClick }, h('span', { class: 'mi-label' }, label), h('span', { class: 'mi-sub' }, sub));
  show(h('div', { class: 'screen dev-screen' }, h('div', { class: 'menu-bg' }),
    h('nav', { class: 'menu-panel panel dev-panel', 'aria-label': 'Developer tools' },
      h('div', { class: 'menu-head' }, h('div', { class: 'h-display', style: 'font-size:26px' }, 'Developer tools')),
      item('Card editor', 'Edit costs, strengths, ability values and text; quick AI-vs-AI test', () => toEditor()),
      item('Replay a game log', 'Open an exported log and step through it', () => pickLogFile((raw, name) => openReplay(raw, name))),
      h('div', { class: 'dev-status' },
        h('div', null, 'Card balance in force: ', h('b', null, b ? `${b.name} (${plural(Object.keys(b.cards).length, 'card')} changed)` : 'standard cards')),
        b ? h('button', { class: 'btn small ghost', onclick: () => { setActiveBalance(null); toDev(); } }, 'Use standard cards') : null),
      h('p', { class: 'dim dev-note' }, 'Batch simulation from a terminal: ', h('code', null, 'npm run sim -- --games 1000 --balance file.json'), '. Logs are exported from the in-game menu or the results screen.'),
      h('div', { class: 'row', style: 'justify-content:space-between;margin-top:8px' },
        h('button', { class: 'btn ghost small', onclick: () => { setDevMode(false); toMenu(); } }, 'Hide developer link'),
        h('button', { class: 'btn', onclick: () => toMenu() }, 'Back')))));
}

function toEditor(): void {
  const ed = new CardEditor(() => toDev());
  show(ed.el, () => ed.destroy());
}

function openReplay(raw: unknown, name: string): void {
  const { log, error } = checkLog(raw);
  if (!log) return void toast(`${name}: ${error}`, 'error', 7000);
  let viewer: ReplayViewer;
  try {
    viewer = new ReplayViewer(log, () => toDev());
  } catch (e) {
    return void toast(`Could not replay ${name}: ${(e as Error).message}`, 'error', 7000);
  }
  show(viewer.el, () => viewer.destroy());
  (window as any).__psi = { replay: viewer };
}

// Dev/test hook: open a log object directly (the menu uses a file picker).
(window as any).__psiDev = { openReplay: (raw: unknown) => openReplay(raw, 'log') };

document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.shiftKey && (e.key === 'D' || e.key === 'd')) {
    if (current?.el.classList.contains('game-screen') || current?.el.classList.contains('replay-host')) return;
    e.preventDefault();
    toDev();
  }
});

function toMenu(): void {
  show(
    mainMenu([
      { label: 'Play vs AI', sub: 'You against 1–3 computer players: Easy, Normal or Hard', onClick: () => toLocal('vsai') },
      { label: 'Host Game', sub: 'Create an online room and share its code', onClick: () => toOnline('host') },
      { label: 'Join Game', sub: 'Enter a room code from a friend', onClick: () => toOnline('join') },
      { label: 'Hot-seat', sub: '2–4 players on one device, hidden-hand curtains; mix in computers', onClick: () => toLocal('hotseat') },
      { label: 'Deck Builder', sub: 'Build, save, import and export decks', onClick: () => { const db = new DeckBuilder(() => toMenu()); show(db.el); } },
      { label: 'How to Play', sub: 'Guided first game and the full rules reference', onClick: () => toHowTo() },
      { label: 'Settings', sub: 'Animation, effects, audio, gameplay, accessibility', onClick: () => toSettings() },
    ], menuFooter()),
  );
}

function toSettings(): void {
  show(h('div', { class: 'screen settings-screen' }, h('div', { class: 'menu-bg' }), h('div', { class: 'settings-page panel' }, h('h2', { class: 'h-display' }, 'Settings'), settingsPanel(() => toMenu()))));
}

function toHowTo(): void {
  let done = false;
  try {
    done = localStorage.getItem('psiwars.tutorialDone') === '1';
  } catch {
    /* ignore */
  }
  const choice = (title: string, text: string, onClick: () => void) =>
    h('button', { class: 'howto-choice', onclick: onClick }, h('h3', null, title), h('p', { class: 'dim' }, text));
  show(h('div', { class: 'screen howto-screen' }, h('div', { class: 'menu-bg' }),
    h('div', { class: 'panel howto-panel' },
      h('h2', { class: 'h-display' }, 'How to Play'),
      h('p', { class: 'dim' }, 'New to Psi Wars? The tutorial is a real game against an Easy computer that explains each phase as you reach it. The rules reference holds every rule, ruling and House Rule, searchable.'),
      h('div', { class: 'howto-choices' },
        choice(done ? 'Replay the tutorial' : 'Start the tutorial', 'A guided first game: one full turn of every phase, with highlights. About 10 minutes; skip at any time.', () => startTutorial()),
        choice('Rules reference', 'The complete rules, House Rules, rulings index and card reference.', () => toRules())),
      h('div', { class: 'row', style: 'margin-top:20px' }, h('button', { class: 'btn', onclick: () => toMenu() }, 'Back')))));
}

function toRules(): void {
  show(h('div', { class: 'screen rules-screen' }, h('div', { class: 'menu-bg' }), h('div', { class: 'panel rules-page' }, rulesReference(() => toHowTo()))));
}

/** The guided first game (data/tutorial.json): fixed seeds so every player sees the same game. */
function startTutorial(): void {
  const deckOf = (id: string) => starterDecks.find((d) => d.id === id) ?? starterDecks[0]!;
  const names = [tutorialCfg.playerName, 'Computer (Easy)'];
  const game = new LocalGame(
    [{ seat: 0, name: names[0]!, kind: 'local' }, { seat: 1, name: names[1]!, kind: 'ai', aiLevel: tutorialCfg.aiLevel as 'easy' }],
    {
      defs: currentDefs(),
      rules,
      seed: tutorialCfg.seed,
      players: [{ name: names[0]!, deck: deckOf(tutorialCfg.playerDeck) }, { name: names[1]!, deck: deckOf(tutorialCfg.aiDeck) }],
      startingHP: tutorialCfg.startingHP,
      autoPassNoPlay: true,
    },
  );
  const tutorial = new Tutorial(() => undefined);
  const screen = new GameScreen(game, game.initialEvents(), {
    onExit: () => toMenu(),
    onRematch: () => startTutorial(),
    openSettings: (host) => openSettingsModal(host),
    aiSeed: tutorialCfg.aiSeed,
    tutorial,
  });
  show(screen.el, () => {
    tutorial.end();
    screen.destroy();
    game.dispose();
  });
  (window as any).__psi = { game, screen, perf, tutorial };
}

function toLocal(preset: 'vsai' | 'hotseat'): void {
  show(localSetup(preset, (cfg) => startLocal(cfg), () => toMenu()));
}

/** Any local mix of 2–4 seats: humans at this device and computer players. */
function startLocal(cfg: LocalConfig): void {
  // One unique display name per seat, used by the board, turn order and log alike.
  const raw = cfg.seats.map((s) => (s.kind === 'human' ? s.name : `${s.name} (${s.kind[0]!.toUpperCase()}${s.kind.slice(1)})`));
  const names = raw.map((n, i) => (raw.filter((x) => x === n).length > 1 ? `${n} ${raw.slice(0, i + 1).filter((x) => x === n).length}` : n));
  const game = new LocalGame(
    cfg.seats.map((s, seat) => (s.kind === 'human' ? { seat, name: names[seat]!, kind: 'local' as const } : { seat, name: names[seat]!, kind: 'ai' as const, aiLevel: s.kind })),
    {
      defs: currentDefs(),
      rules,
      seed: randomSeed(),
      players: cfg.seats.map((s, i) => ({ name: names[i]!, deck: s.deck })),
      startingHP: cfg.startingHP,
      diceVariant: cfg.diceVariant,
      autoPassNoPlay: settings().autoPass,
    },
  );
  const screen = new GameScreen(game, game.initialEvents(), {
    onExit: () => toMenu(),
    onRematch: () => startLocal(cfg),
    openSettings: (host) => openSettingsModal(host),
  });
  show(screen.el, () => {
    screen.destroy();
    game.dispose();
  });
  (window as any).__psi = { game, screen, perf };
}

function toOnline(mode: 'host' | 'join', prefill = ''): void {
  show(onlineEntry(mode, prefill, async (code, name, deck) => {
    try {
      goOnline(code ?? (await createRoom()), name, deck);
    } catch (e) {
      toast((e as Error).message, 'error', 6000);
    }
  }, () => toMenu()));
}

/** One online session: the lobby and game screens swap inside one host element. */
function goOnline(code: string, name: string, deck: StoredDeck): void {
  history.replaceState(null, '', `?room=${code}`);
  try {
    sessionStorage.setItem('psiwars.session', JSON.stringify({ code, name, deckId: deck.id }));
  } catch {
    /* ignore */
  }
  const game = new RemoteGame(code, name, deckPayload(deck));
  const root = h('div', { class: 'screen-host', style: 'position:absolute;inset:0' });
  let screen: GameScreen | null = null;
  let badge: HTMLElement | null = null;
  const leave = () => {
    history.replaceState(null, '', location.pathname);
    try {
      sessionStorage.removeItem('psiwars.session');
    } catch {
      /* ignore */
    }
    toMenu();
  };
  const lobby = new LobbyScreen(game, leave);
  root.appendChild(lobby.el);
  const off = game.onNotice((n) => {
    switch (n.kind) {
      case 'lobby':
      case 'welcome':
        if (!screen) lobby.render();
        break;
      case 'status':
        lobby.setStatus(n.status);
        badge?.remove();
        badge = null;
        if (n.status === 'reconnecting' && screen) {
          badge = h('div', { class: 'net-badge', role: 'status' }, 'Connection lost — reconnecting…');
          root.appendChild(badge);
        }
        break;
      case 'error':
        toast(n.message, n.fatal ? 'error' : 'warn', 6000);
        if (n.fatal) leave();
        break;
      case 'gameStarted':
        screen?.destroy();
        lobby.el.remove();
        screen = new GameScreen(game, game.initialLog, {
          onExit: leave,
          onRematch: game.isHost ? () => game.lobbyAction({ t: 'start' }) : undefined,
          openSettings: (host) => openSettingsModal(host),
        });
        root.appendChild(screen.el);
        (window as any).__psi = { game, screen, perf };
        break;
      case 'graceExpired':
        if (screen && game.isHost) {
          let m: ReturnType<typeof openModal>;
          m = openModal(screen.el, `${n.name} lost connection`, 'Their seat has been held for two minutes. Hand it to the computer, or keep waiting for them to rejoin with the same link.', null, [
            { label: 'Keep waiting', onClick: () => m.close() },
            { label: 'Computer (Easy)', onClick: () => { m.close(); game.lobbyAction({ t: 'replaceWithAi', seat: n.seat, level: 'easy' }); } },
            { label: 'Computer (Normal)', primary: true, onClick: () => { m.close(); game.lobbyAction({ t: 'replaceWithAi', seat: n.seat, level: 'normal' }); } },
          ]);
        }
        break;
    }
  });
  show(root, () => {
    off();
    screen?.destroy();
    game.dispose();
  });
  (window as any).__psi = { game, lobby, perf };
}

async function boot(): Promise<void> {
  applySettings();
  fitStage();
  unlockAudioOnGesture();
  perf.start();
  await loadManifest();
  const bg = artUrl('ui/menu-bg', '1920');
  if (bg) document.documentElement.style.setProperty('--menu-bg-url', `url("${bg}")`);
  const params = new URLSearchParams(location.search);
  if (params.has('dev')) setDevMode(true);
  const room = params.get('room')?.toUpperCase();
  let session: { code: string; name: string; deckId: string } | null = null;
  try {
    session = JSON.parse(sessionStorage.getItem('psiwars.session') ?? 'null');
  } catch {
    session = null;
  }
  // A reload in the same tab goes straight back to the seat (same client id, §4.1 reconnect).
  if (room && session?.code === room) goOnline(room, session.name, playableDecks().find((d) => d.id === session!.deckId) ?? starterDecks[0]!);
  else if (room) toOnline('join', room);
  else show(titleScreen(() => toMenu()));
}

stage.appendChild(h('div', { id: 'toasts' }));
(window as any).__psiSettings = { settings, updateSettings };
void boot();
