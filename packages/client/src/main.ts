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
import { localSetup, mainMenu, titleScreen, type LocalConfig } from './ui/screens';
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
      { label: 'Play vs AI', sub: 'You against 1–3 computer players: Easy, Normal or Hard', onClick: () => toLocal('vsai') },
      { label: 'Host Game', sub: 'Create an online room and share its code', onClick: () => toOnline('host') },
      { label: 'Join Game', sub: 'Enter a room code from a friend', onClick: () => toOnline('join') },
      { label: 'Hot-seat', sub: '2–4 players on one device, hidden-hand curtains; mix in computers', onClick: () => toLocal('hotseat') },
      { label: 'Deck Builder', sub: 'Build and save decks', disabledReason: 'Arrives in Stage 7' },
      { label: 'How to Play', sub: 'Rules reference and tutorial', disabledReason: 'Arrives in Stage 7' },
      { label: 'Settings', sub: 'Animation, effects, audio, gameplay, accessibility', onClick: () => toSettings() },
    ]),
  );
}

function toSettings(): void {
  show(h('div', { class: 'screen settings-screen' }, h('div', { class: 'menu-bg' }), h('div', { class: 'settings-page panel' }, h('h2', { class: 'h-display' }, 'Settings'), settingsPanel(() => toMenu()))));
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
  const room = new URLSearchParams(location.search).get('room')?.toUpperCase();
  let session: { code: string; name: string; deckId: string } | null = null;
  try {
    session = JSON.parse(sessionStorage.getItem('psiwars.session') ?? 'null');
  } catch {
    session = null;
  }
  // A reload in the same tab goes straight back to the seat (same client id, §4.1 reconnect).
  if (room && session?.code === room) goOnline(room, session.name, starterDecks.find((d) => d.id === session!.deckId) ?? starterDecks[0]!);
  else if (room) toOnline('join', room);
  else show(titleScreen(() => toMenu()));
}

stage.appendChild(h('div', { id: 'toasts' }));
(window as any).__psiSettings = { settings, updateSettings };
void boot();
