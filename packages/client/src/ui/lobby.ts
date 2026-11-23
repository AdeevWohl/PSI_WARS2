/** Online: Host / Join screens and the room lobby (§4.1). */
import { isRoomCode, normalizeRoomCode, type DeckPayload, type LobbyState, type RoomConfig } from '@psi-wars/shared';
import { artUrl, preload } from '../assets';
import { currentDefs, starterDecks, type StoredDeck } from '../data';
import type { RemoteGame } from '../net/remote';
import { SEAT_COLORS } from '../render/board';
import { h, toast } from './dom';

export function deckPayload(d: StoredDeck): DeckPayload {
  return { name: d.name, battle: d.battle, resource: d.resource };
}

function savedName(): string {
  try {
    return localStorage.getItem('psiwars.name') ?? '';
  } catch {
    return '';
  }
}
function saveName(n: string): void {
  try {
    localStorage.setItem('psiwars.name', n);
  } catch {
    /* ignore */
  }
}

/** Host or join: nickname, deck, and (for join) the room code. */
export function onlineEntry(mode: 'host' | 'join', prefill: string, onGo: (code: string | null, name: string, deck: StoredDeck) => void, onBack: () => void): HTMLElement {
  const decks = starterDecks;
  let deck = decks[0]!;
  const name = h('input', { class: 'text-input', value: savedName(), placeholder: 'Your nickname', maxlength: '20', 'aria-label': 'Nickname' }) as HTMLInputElement;
  const code = h('input', { class: 'text-input code-input', value: prefill, placeholder: 'ROOM CODE', maxlength: '6', 'aria-label': 'Room code', autocapitalize: 'characters', spellcheck: 'false' }) as HTMLInputElement;
  code.addEventListener('input', () => (code.value = normalizeRoomCode(code.value)));
  const deckSel = h('select', { class: 'text-input', onchange: (e: Event) => (deck = decks.find((d) => d.id === (e.target as HTMLSelectElement).value)!) }, ...decks.map((d) => h('option', { value: d.id }, d.name)));
  const go = h('button', { class: 'btn primary', style: 'font-size:18px;padding:12px 34px' }, mode === 'host' ? 'Create room' : 'Join room');
  go.addEventListener('click', () => {
    const n = name.value.trim() || 'Player';
    saveName(n);
    if (mode === 'join') {
      const c = normalizeRoomCode(code.value);
      if (!isRoomCode(c)) return toast('Room codes are 6 letters and digits (no 0, O, 1, I or L).', 'warn');
      onGo(c, n, deck);
    } else onGo(null, n, deck);
  });
  const onKey = (e: KeyboardEvent) => e.key === 'Enter' && go.click();
  name.addEventListener('keydown', onKey);
  code.addEventListener('keydown', onKey);
  requestAnimationFrame(() => (mode === 'join' && !prefill ? code : name).focus({ preventScroll: true }));
  return h('div', { class: 'screen setup-screen' },
    h('div', { class: 'menu-bg' }),
    h('div', { class: 'setup-panel panel', style: 'width:720px' },
      h('h2', { class: 'h-display' }, mode === 'host' ? 'Host an online game' : 'Join an online game'),
      h('p', { class: 'dim' }, mode === 'host' ? 'You will get a room code to share. Friends join from any network — no accounts, nicknames only.' : 'Type the 6-character code your host shared, or open their invite link.'),
      mode === 'join' ? h('div', { style: 'margin:16px 0' }, h('label', { class: 'field-label' }, 'Room code'), code) : null,
      h('div', { class: 'opt-row' },
        h('div', null, h('label', { class: 'field-label' }, 'Nickname'), name),
        h('div', null, h('label', { class: 'field-label' }, 'Deck'), deckSel)),
      h('div', { class: 'row' }, h('button', { class: 'btn', onclick: onBack }, 'Back'), go)));
}

export class LobbyScreen {
  readonly el: HTMLElement;
  private body = h('div', { class: 'lobby-body' });
  private status = h('div', { class: 'conn-status' });
  private preloaded = false;
  private progress = h('div', { class: 'progress' }, h('div', { class: 'progress-fill' }));
  private progressLabel = h('div', { class: 'dim', style: 'font-size:12px;min-height:16px' });

  constructor(private game: RemoteGame, private onLeave: () => void) {
    this.el = h('div', { class: 'screen lobby-screen' },
      h('div', { class: 'menu-bg' }),
      h('div', { class: 'lobby-panel panel' }, this.status, this.body, h('div', { class: 'lobby-preload' }, this.progress, this.progressLabel)));
    this.render();
    void this.preloadArt();
  }

  /** Preload every enabled card's art while people gather, so nothing pops in mid-game (§5.2). */
  private async preloadArt(): Promise<void> {
    if (this.preloaded) return;
    this.preloaded = true;
    const defs = currentDefs();
    const urls: string[] = [artUrl('backs/battle', 'sm')!, artUrl('backs/resource', 'sm')!];
    for (const d of Object.values(defs)) if (d.enabled) for (const s of ['sm', 'md'] as const) { const u = artUrl(d.art, s); if (u) urls.push(u); }
    await preload(urls, (n, t) => {
      (this.progress.firstChild as HTMLElement).style.transform = `scaleX(${t ? n / t : 1})`;
      this.progressLabel.textContent = n < t ? `Preparing card art… ${n} / ${t}` : 'Card art ready.';
    });
  }

  setStatus(s: string): void {
    this.status.textContent = s === 'open' ? '' : s === 'reconnecting' ? 'Connection lost — reconnecting…' : s === 'connecting' ? 'Connecting…' : 'Disconnected';
    this.status.classList.toggle('bad', s !== 'open');
  }

  render(): void {
    const g = this.game;
    const lobby: LobbyState | null = g.lobby;
    const code = g.code;
    const link = `${location.origin}${location.pathname}?room=${code}`;
    const copy = (text: string, what: string) => {
      void navigator.clipboard?.writeText(text).then(() => toast(`${what} copied`), () => toast(text));
    };
    if (!lobby) {
      this.body.replaceChildren(h('h2', { class: 'h-display' }, `Room ${code}`), h('p', { class: 'dim' }, 'Connecting to the room…'), h('div', { class: 'row' }, h('button', { class: 'btn', onclick: this.onLeave }, 'Leave')));
      return;
    }
    const host = g.isHost;
    const me = g.mySeat;
    const filled = lobby.seats.every((s) => s.kind !== 'open');
    const seatRows = lobby.seats.map((s) => {
      const mine = s.seat === me;
      const right: Node[] = [];
      if (s.kind === 'open') {
        if (host) for (const lv of ['easy', 'normal', 'hard'] as const) right.push(h('button', { class: 'btn small', onclick: () => g.lobbyAction({ t: 'seatAi', seat: s.seat, level: lv }) }, `+ ${lv[0]!.toUpperCase()}${lv.slice(1)} AI`));
        else if (me !== null) right.push(h('button', { class: 'btn small', onclick: () => g.lobbyAction({ t: 'takeSeat', seat: s.seat }) }, 'Sit here'));
      } else if (s.kind === 'ai' && host) right.push(h('button', { class: 'btn small ghost', onclick: () => g.lobbyAction({ t: 'seatAi', seat: s.seat, level: null }) }, 'Remove'));
      else if (s.kind === 'human' && host && !mine) right.push(h('button', { class: 'btn small ghost', onclick: () => g.lobbyAction({ t: 'kick', seat: s.seat }) }, 'Kick'));
      return h('div', { class: `lobby-seat${mine ? ' mine' : ''}`, style: { '--seat-color': SEAT_COLORS[s.seat] } as any },
        h('span', { class: 'seat-dot' }),
        h('div', { class: 'seat-info' },
          h('div', { class: 'seat-name' }, s.kind === 'open' ? h('span', { class: 'faint' }, 'Open seat') : s.name, mine ? h('span', { class: 'tag' }, 'you') : null, s.isHost ? h('span', { class: 'tag host' }, 'host') : null),
          h('div', { class: 'seat-sub dim' }, s.kind === 'ai' ? `Computer · ${s.aiLevel} · ${s.deckName ?? ''}` : s.kind === 'human' ? `${s.deckName ?? 'no deck'} · ${s.connected ? (s.ready ? 'ready' : 'not ready') : 'offline'}` : '')),
        h('div', { class: 'seat-actions' }, ...right));
    });

    const cfg = lobby.config;
    const setCfg = (patch: Partial<RoomConfig>) => g.lobbyAction({ t: 'config', config: patch });
    const sel = (value: string | number, opts: [string | number, string][], on: (v: string) => void, disabled: boolean) =>
      h('select', { class: 'text-input small', disabled: disabled ? true : undefined, onchange: (e: Event) => on((e.target as HTMLSelectElement).value) }, ...opts.map(([v, l]) => h('option', { value: String(v), selected: String(v) === String(value) ? true : undefined }, l)));
    const settings = h('div', { class: 'lobby-settings' },
      h('h3', null, host ? 'Room settings (you are the host)' : 'Room settings'),
      row('Players', sel(cfg.seats, [[2, '2'], [3, '3'], [4, '4']], (v) => setCfg({ seats: Number(v) }), !host)),
      row('Starting Lab HP', sel(cfg.startingHP, Array.from({ length: 11 }, (_, k) => [10 + k, String(10 + k)] as [number, string]), (v) => setCfg({ startingHP: Number(v) }), !host)),
      row('Dice', sel(cfg.diceVariant, [['standard', 'Standard'], ['noModifier', 'No modifier dice']], (v) => setCfg({ diceVariant: v as RoomConfig['diceVariant'] }), !host)),
      row('Trap response window', sel(cfg.trapWindowSec, Array.from({ length: 11 }, (_, k) => [k, `${k} s`] as [number, string]), (v) => setCfg({ trapWindowSec: Number(v) }), !host)),
      row('Fast windows', h('input', { type: 'checkbox', class: 'toggle', checked: cfg.fastWindows ? true : undefined, disabled: host ? undefined : true, onchange: (e: Event) => setCfg({ fastWindows: (e.target as HTMLInputElement).checked }) }), 'Skips players who cannot play anything — faster, but a pause then reveals that someone holds a Trap.'),
      row('Turn timer', sel(cfg.turnTimerSec, [[0, 'Off'], [30, '30 s'], [60, '60 s'], [120, '120 s']], (v) => setCfg({ turnTimerSec: Number(v) }), !host)),
    );

    const mySeat = me !== null ? lobby.seats[me] : undefined;
    const decks = starterDecks;
    const mine = mySeat
      ? h('div', { class: 'lobby-me' },
          h('h3', null, 'You'),
          row('Nickname', h('input', { class: 'text-input small', value: mySeat.name, maxlength: '20', onchange: (e: Event) => g.lobbyAction({ t: 'setName', name: (e.target as HTMLInputElement).value }) })),
          row('Deck', sel(decks.find((d) => d.name === mySeat.deckName)?.id ?? decks[0]!.id, decks.map((d) => [d.id, d.name] as [string, string]), (v) => g.lobbyAction({ t: 'setDeck', deck: deckPayload(decks.find((d) => d.id === v)!) }), false)),
          host ? null : h('button', { class: `btn${mySeat.ready ? '' : ' primary'}`, onclick: () => g.lobbyAction({ t: 'ready', ready: !mySeat.ready }) }, mySeat.ready ? 'Not ready' : "I'm ready"))
      : h('div', { class: 'lobby-me' }, h('h3', null, 'Watching'), h('p', { class: 'dim' }, 'All seats are taken; you are a spectator.'));

    this.body.replaceChildren(
      h('div', { class: 'lobby-head' },
        h('div', null, h('div', { class: 'dim', style: 'font-size:13px;letter-spacing:.2em' }, 'ROOM CODE'), h('div', { class: 'room-code', 'aria-label': `Room code ${code.split('').join(' ')}` }, code)),
        h('div', { class: 'lobby-share' },
          h('button', { class: 'btn', onclick: () => copy(link, 'Invite link') }, 'Copy invite link'),
          h('button', { class: 'btn ghost', onclick: () => copy(code, 'Code') }, 'Copy code'))),
      h('div', { class: 'lobby-grid' },
        h('div', { class: 'lobby-seats' }, h('h3', null, `Players (${lobby.seats.filter((s) => s.kind !== 'open').length}/${lobby.seats.length})`), ...seatRows),
        h('div', null, mine, settings)),
      h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: this.onLeave }, 'Leave room'),
        host
          ? h('button', { class: 'btn primary', disabled: filled ? undefined : true, title: filled ? '' : 'Fill every seat with a player or the computer', onclick: () => g.lobbyAction({ t: 'start' }) }, filled ? 'Start game' : 'Waiting for players…')
          : h('div', { class: 'dim' }, 'The host starts the game.')),
    );
  }
}

function row(label: string, control: HTMLElement, hint?: string): HTMLElement {
  return h('div', { class: 'set-row' }, h('label', { class: 'set-label' }, label, hint ? h('span', { class: 'set-hint' }, hint) : null), control);
}
