/** Hover / long-press enlarged card with rules text and the rulings that apply (§5.3). */
import type { CardDef, UnitStats } from '@psi-wars/engine';
import { rulingsFor } from '../data';
import { createCardEl, describe, updateOverlays } from '../render/card';
import { h } from './dom';

export class Preview {
  readonly el = h('div', { class: 'preview', 'aria-hidden': 'true' });
  enabled = true;
  size = 330;

  show(def: CardDef, opts: { stats?: UnitStats; side?: 'left' | 'right'; faceDown?: boolean } = {}): void {
    if (!this.enabled) return;
    const card = createCardEl(null, def, { size: 'md' });
    card.style.setProperty('--w', `${this.size}px`);
    card.style.width = `${this.size}px`;
    updateOverlays(card, def, { stats: opts.stats });
    const type = def.cardType === 'BattleUnit' ? `${def.unitType}${def.isCommander ? ' Commander' : ''}` : def.cardType === 'CreationUnit' ? 'Creation Unit' : def.cardType;
    const rul = rulingsFor(def);
    const text = h(
      'div',
      { class: 'pv-text panel' },
      h('div', { class: 'pv-name' }, def.name),
      h('div', { class: 'pv-type' }, type),
      def.text ? h('div', null, def.text) : null,
      def.implementation ? h('div', { class: 'dim', style: 'font-size:12px;margin-top:6px' }, def.implementation) : null,
      ...rul.slice(0, 4).map((r) => h('div', { class: 'pv-ruling' }, h('b', null, r.id.startsWith('HR') ? 'HOUSE RULE ' : r.id.startsWith('QA') ? 'Q&A ' : 'RULING '), `${r.id.replace(/^(HR|QA)-/, '')} · ${r.title}: ${r.text}`)),
    );
    this.el.replaceChildren(card, text);
    this.el.classList.toggle('right', opts.side === 'right');
    this.el.classList.add('show');
    this.el.setAttribute('aria-label', describe(def));
  }

  hide(): void {
    this.el.classList.remove('show');
  }
}
