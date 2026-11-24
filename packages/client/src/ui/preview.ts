/** Hover / long-press enlarged card with its full rules text underneath. */
import type { CardDef, UnitStats } from '@psi-wars/engine';
import { createCardEl, describe, updateOverlays } from '../render/card';
import { h } from './dom';
import { KEYWORD_HELP, keywordsFor } from '../render/keywords';

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
    const text = h(
      'div',
      { class: 'pv-text panel' },
      h('div', { class: 'pv-name' }, def.name),
      h('div', { class: 'pv-type' }, type),
      def.text ? h('div', null, def.text) : null,
      def.protocols ? h('div', { class: 'pv-protocols' }, ...Object.entries(def.protocols).map(([m, d]) => h('div', null, h('b', null, `${m}: `), d))) : null,
      ...keywordsFor(def).map((k) => h('div', { class: 'pv-kw' }, h('b', null, `${k}: `), KEYWORD_HELP[k]!)),
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
