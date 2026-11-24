/**
 * Tutorial (§8): a guided first game against the Easy AI that walks one full turn of each
 * phase, with spotlight highlighting and short explanations. Skippable and replayable.
 * Steps advance on real game state (prompts and events), so the game is never blocked: the
 * overlay only points and explains.
 */
import type { GameEvent } from '@psi-wars/shared';
import type { GameView, LegalView } from '@psi-wars/engine';
import { toStage } from '../anim/flip';
import { h } from './dom';

export interface TutorialCtx {
  view: GameView;
  legal: LegalView | null;
  events: GameEvent[];
  me: number;
}

interface Step {
  id: string;
  title: string;
  text: string;
  /** CSS selector (or function) for the element to spotlight. */
  target?: string | ((c: TutorialCtx) => Element | null);
  /** Step waits until this is true before showing (default: show at once). */
  when?: (c: TutorialCtx) => boolean;
  /** Step completes when this becomes true; otherwise it shows a Next button. */
  until?: (c: TutorialCtx) => boolean;
  /** While waiting: if true, the step's moment has passed and it is skipped. */
  skip?: (c: TutorialCtx) => boolean;
  /** Shown whenever its `when` holds, even out of order (once). */
  interrupt?: boolean;
  /** While waiting for `when`: show the "nothing affordable" tip instead of hiding. */
  waitTip?: (c: TutorialCtx) => boolean;
}

const evBy = (c: TutorialCtx, type: string, pred: (e: GameEvent) => boolean = () => true) => c.events.some((e) => e.type === type && pred(e));
const canPlay = (c: TutorialCtx, type: string) => !!c.legal?.plays.some((x) => c.view.defs[x.cardId]?.cardType === type);
const myPrompt = (c: TutorialCtx, kind: string) => c.view.prompt?.seat === c.me && c.view.prompt.kind === kind;

const STEPS: Step[] = [
  { id: 'welcome', title: 'Welcome, Warlord', text: 'This guided game teaches one full turn of every phase. You play the Creature Commander deck against an Easy computer. Click Next to continue, or Skip tutorial at any time.' },
  { id: 'mine', title: 'Your Lab', target: '.area.mine', text: 'Your side of the board: your Battle Units, your Creation Units (the "mana" that pays for cards), and your hand of Battle cards at the bottom. Your Lab HP is next to your name — keep it above zero.' },
  { id: 'opp', title: 'Your opponent', target: '.area:not(.mine)', text: 'Their Lab: units, Creation Units, HP and how many cards they hold. You never see their hand.' },
  { id: 'panel', title: 'The side panel', target: '.side', text: 'The turn tracker shows the five phases — Replenish, Draw, Create, Battle, Cleanup — and whose turn it is. Below it are the current decision and its buttons, the last battle’s dice maths, and the battle log.' },
  { id: 'cus', title: 'Draw phase and Creation Units', target: '.area.mine .cu-group', when: (c) => myPrompt(c, 'main'), skip: (c) => c.view.turn.number > 1, text: 'Each turn you draw one Resource card and one Battle card (the first player skips the Battle draw on turn 1). Creation Units go straight into your Lab — these are yours. A card’s cost lights (top left of the card) say how many of each colour to deplete; the white light is how many to destroy. Most units need two or three.' },
  {
    id: 'turn1', title: 'Creation phase', target: '.prompt-actions .btn.primary',
    when: (c) => myPrompt(c, 'main') && !canPlay(c, 'BattleUnit'),
    skip: (c) => c.view.turn.number > 1 || canPlay(c, 'BattleUnit'),
    until: (c) => c.view.phase !== 'creation' || c.view.turn.active !== c.me,
    text: 'Nothing in your hand is affordable yet — hover a dimmed card to see what it is missing. Click Go to Battle (or press Space). With no units there is nothing to attack with, so your turn ends.',
  },
  {
    id: 'their', title: 'Their turn', when: (c) => c.view.turn.active !== c.me,
    skip: (c) => myPrompt(c, 'main') && canPlay(c, 'BattleUnit'),
    until: (c) => c.view.turn.active === c.me && c.view.turn.number >= 3,
    text: 'Now the computer takes its turn — watch its moves in the log. If it attacks you, you will be asked to block.',
  },
  {
    id: 'oracleHand', title: 'Use your Creation Oracle',
    target: (c) => {
      const p = c.legal?.plays.find((x) => c.view.defs[x.cardId]?.cardType === 'Resource');
      return p ? document.querySelector(`.hand .card[data-uid="${p.uid}"]`) : null;
    },
    when: (c) => myPrompt(c, 'main') && canPlay(c, 'Resource') && !canPlay(c, 'BattleUnit'),
    skip: (c) => canPlay(c, 'BattleUnit') || c.view.turn.number > 7,
    waitTip: (c) => myPrompt(c, 'main'),
    until: (c) => canPlay(c, 'BattleUnit') || c.view.turn.active !== c.me,
    text: 'Still one Creation Unit short. The Creation Oracle you kept can be played in your Creation phase: click it and choose Neurogenesis (blue).',
  },
  {
    id: 'play', title: 'Play a Battle Unit',
    target: (c) => {
      const p = c.legal?.plays.find((x) => c.view.defs[x.cardId]?.cardType === 'BattleUnit');
      return p ? document.querySelector(`.hand .card[data-uid="${p.uid}"]`) : null;
    },
    when: (c) => myPrompt(c, 'main') && !!c.legal?.plays.some((x) => c.view.defs[x.cardId]?.cardType === 'BattleUnit'),
    skip: (c) => c.view.turn.number > 7,
    until: (c) => evBy(c, 'CardPlayed', (e) => e.seat === c.me && e.cardType === 'BattleUnit'),
    text: 'Glowing cards are affordable: click this one (or drag it onto the board) to create it. Hover any card to read it in full.',
  },
  {
    id: 'ready', title: 'Ready to fight', target: '.prompt-actions .btn.primary',
    when: (c) => myPrompt(c, 'main'),
    skip: (c) => c.view.phase === 'battle' || c.view.turn.active !== c.me,
    until: (c) => c.view.phase === 'battle' || c.view.turn.active !== c.me,
    text: 'New units can attack the turn they are created. Click Go to Battle.',
  },
  {
    id: 'attack', title: 'Battle step 1: declare attackers', target: '.area.mine .units-row',
    when: (c) => myPrompt(c, 'declareAttackers'),
    skip: (c) => c.view.turn.number > 9,
    until: (c) => evBy(c, 'AttackersDeclared', (e) => e.seat === c.me && (e.attacks as unknown[]).length > 0) || c.view.turn.active !== c.me,
    text: 'Click your unit to send it into battle, then click Attack (or Space). Attacking depletes it, but survivors are made ready again in Cleanup, and depleted units can still block.',
  },
  {
    id: 'battle', title: 'How battles work', target: '.breakdown',
    when: (c) => evBy(c, 'UnblockedHit', (e) => e.seat === c.me) || evBy(c, 'BattleResolved', (e) => (e.att as { seat: number }).seat === c.me),
    skip: (c) => c.view.turn.number > 10,
    text: 'Defenders may block one attacker each; an unblocked attacker hits their Lab for its Physical strength. In a blocked battle both sides roll: Cyber decides who is Disoriented (can’t destroy), Psionic gives "Psionic win" effects, and Physical decides who is destroyed. This panel shows strength + die = total for each.',
  },
  {
    id: 'cleanup', title: 'Cleanup',
    text: 'In Cleanup your surviving attackers return to your Lab, stacks split, and trapped units try to escape. Then the next player begins with Replenish, readying all their cards.',
  },
  {
    id: 'equip', title: 'Equipment',
    target: (c) => {
      const p = c.legal?.plays.find((x) => c.view.defs[x.cardId]?.cardType === 'Equipment');
      return p ? document.querySelector(`.hand .card[data-uid="${p.uid}"]`) : null;
    },
    when: (c) => myPrompt(c, 'main') && !!c.legal?.plays.some((x) => c.view.defs[x.cardId]?.cardType === 'Equipment'),
    skip: (c) => c.view.turn.number > 11,
    until: (c) => evBy(c, 'EquipmentAttached', (e) => e.seat === c.me) || c.view.turn.active !== c.me,
    text: 'Equipment boosts one ability of a unit, immediately and permanently. Click it, then click the glowing unit to attach it (or drag it onto the unit). Each unit holds one Equipment.',
  },
  {
    id: 'done', title: 'You know the basics', target: '.game-menu-btn',
    text: 'That is a full turn of every phase. Power cards and Traps can be played at any time, even in response to your opponent. The Menu has the full rules reference. Finish this game, or quit to the main menu whenever you like. Good luck, Warlord!',
  },
];

const ORACLE: Step = {
  id: 'oracle', title: 'A Creation Oracle', target: '.modal', interrupt: true,
  when: (c) => myPrompt(c, 'oracle') || (myPrompt(c, 'chooseCard') && /oracle/i.test(c.view.prompt?.label ?? '')),
  until: (c) => !myPrompt(c, 'oracle') && !myPrompt(c, 'chooseCard'),
  text: 'Creation Oracles are wild Resource cards: use one to fetch the Creation Unit of your choice from your Resource deck, or keep it for a later Creation phase.',
};

const BLOCK: Step = {
  id: 'block', title: 'Battle step 2: blocking', target: '.battlefield', interrupt: true,
  when: (c) => myPrompt(c, 'declareBlockers'),
  until: (c) => !myPrompt(c, 'declareBlockers'),
  text: 'You are being attacked! Click one of your units, then the attacker it should block (one defender per attacker) — or confirm No blocks and take the damage. Depleted units can block.',
};

const DECIDE_KINDS = ['optionalRoll', 'reroll', 'disable', 'battleOrder'];
const ABILITY: Step = {
  id: 'ability', title: 'Card abilities', target: '.modal', interrupt: true,
  when: (c) => c.view.prompt?.seat === c.me && DECIDE_KINDS.includes(c.view.prompt.kind),
  until: (c) => !(c.view.prompt?.seat === c.me && DECIDE_KINDS.includes(c.view.prompt.kind)),
  text: 'Some cards have abilities that ask you to decide — like this optional roll, or which battle to fight first. The dialog explains the choice; hover any card for its full text. Either answer is fine here.',
};

const INTERRUPTS = [BLOCK, ORACLE, ABILITY];

const WAIT: Step = {
  id: 'wait', title: 'Not enough Creation Units yet', target: '.prompt-actions .btn.primary',
  until: () => false,
  text: 'Nothing in your hand is affordable this turn — hover a dimmed card to see what it is missing. You draw a new Resource card every turn. Click Go to Battle to end your turn.',
};

export class Tutorial {
  readonly el: HTMLElement;
  private ring = h('div', { class: 'tut-ring', 'aria-hidden': 'true' });
  private card = h('div', { class: 'tut-card panel', role: 'dialog', 'aria-live': 'polite' });
  private i = 0;
  private shown = new Set<string>();
  private active: Step | null = null;
  private ended = false;
  private last: TutorialCtx | null = null;

  constructor(private onEnd: () => void) {
    this.el = h('div', { class: 'tutorial' }, this.ring, this.card);
    window.addEventListener('resize', this.reposition);
  }

  private reposition = () => this.last && this.place(this.last);

  update(c: TutorialCtx): void {
    if (this.ended) return;
    this.last = c;
    // Interrupt tips (blocking, Oracles) appear whenever they apply, once each.
    if (this.active?.interrupt) {
      if (!this.active.until!(c)) return this.place(c);
      this.shown.add(this.active.id);
      this.active = null;
    }
    const tip = INTERRUPTS.find((t) => !this.shown.has(t.id) && t.when!(c));
    if (tip) return this.show(tip, c);
    let guard = 0;
    while (guard++ < STEPS.length) {
      const s = STEPS[this.i];
      if (!s) return this.end();
      if (this.active !== s) {
        if (s.when && !s.when(c)) {
          // A step whose moment has passed (e.g. no Equipment drawn this game) is skipped.
          if (s.skip?.(c)) {
            this.i++;
            continue;
          }
          if (s.waitTip?.(c)) {
            if (this.active !== WAIT) this.show(WAIT, c);
            else this.place(c);
            return;
          }
          this.hide();
          return;
        }
        this.show(s, c);
        return;
      }
      if (s.until && s.until(c)) {
        this.shown.add(s.id);
        this.i++;
        this.active = null;
        continue;
      }
      this.place(c);
      return;
    }
  }

  private show(s: Step, c: TutorialCtx): void {
    this.active = s;
    const isLast = s.id === 'done';
    this.card.replaceChildren(
      h('div', { class: 'tut-step faint' }, s.interrupt || s === WAIT ? 'Tip' : `Step ${Math.min(this.i + 1, STEPS.length)} of ${STEPS.length}`),
      h('h3', null, s.title),
      h('p', null, s.text),
      h('div', { class: 'tut-actions' },
        h('button', { class: 'btn small ghost', onclick: () => this.end() }, 'Skip tutorial'),
        !s.until ? h('button', { class: 'btn small primary', onclick: () => this.next() }, isLast ? 'Finish' : 'Next') : h('span', { class: 'dim', style: 'font-size:13px' }, 'Waiting for you…')),
    );
    this.el.classList.add('show');
    this.place(c);
    if (!s.until) requestAnimationFrame(() => (this.card.querySelector('.btn.primary') as HTMLElement | null)?.focus({ preventScroll: true }));
  }

  private next(): void {
    if (!this.active) return;
    this.shown.add(this.active.id);
    if (this.active.id === 'done') return this.end();
    if (this.active.interrupt) this.active = null;
    else {
      this.i++;
      this.active = null;
    }
    if (this.last) this.update(this.last);
  }

  private place(c: TutorialCtx): void {
    const s = this.active;
    if (!s) return;
    // A selector spotlights the union of everything it matches (e.g. all Creation Unit groups).
    const els = typeof s.target === 'function' ? [s.target(c)].filter((e): e is Element => !!e) : s.target ? [...document.querySelectorAll(s.target)] : [];
    const rects = els.filter((e) => e.isConnected).map((e) => e.getBoundingClientRect()).filter((b) => b.width > 0);
    if (rects.length) {
      const l = Math.min(...rects.map((b) => b.left)), t = Math.min(...rects.map((b) => b.top));
      const r = toStage(new DOMRect(l, t, Math.max(...rects.map((b) => b.right)) - l, Math.max(...rects.map((b) => b.bottom)) - t));
      Object.assign(this.ring.style, { display: 'block', left: `${r.x - 8}px`, top: `${r.y - 8}px`, width: `${r.w + 16}px`, height: `${r.h + 16}px` });
      const below = r.y + r.h / 2 < 540;
      const left = Math.max(16, Math.min(1920 - 460 - 16, r.cx - 230));
      Object.assign(this.card.style, { left: `${left}px`, top: below ? `${Math.min(1080 - 260, r.y + r.h + 18)}px` : 'auto', bottom: below ? 'auto' : `${Math.min(1080 - 200, 1080 - r.y + 18)}px` });
    } else {
      this.ring.style.display = 'none';
      Object.assign(this.card.style, { left: `${(1920 - 392 - 460) / 2}px`, top: '360px', bottom: 'auto' });
    }
  }

  private hide(): void {
    this.el.classList.remove('show');
    this.active = null;
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    window.removeEventListener('resize', this.reposition);
    this.el.remove();
    try {
      localStorage.setItem('psiwars.tutorialDone', '1');
    } catch {
      /* ignore */
    }
    this.onEnd();
  }
}
