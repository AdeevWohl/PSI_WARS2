/**
 * Deck builder (§14): enforces §A12 limits and the A12-a digital minimums (Battle Deck 30–40
 * with at least 12 Battle Units; Resource Deck 18–24; max 3 copies; max 20 CUs, 8 per type).
 * Save, load, duplicate, rename, delete, export and import decks as JSON.
 */
import { validateDeck, type CardDef } from '@psi-wars/engine';
import { currentDefs, rules, starterDecks } from '../data';
import { canAdd, deckCounts, exportDeckJson, parseDeckImport, type StoredDeck } from '../deck-io';
import { customDecks, deleteDeck, newDeckId, saveDeck } from '../decks';
import { createCardEl, updateOverlays } from '../render/card';
import { h, toast } from './dom';
import { openModal } from './modals';
import { Preview } from './preview';

type Filter = 'all' | 'BattleUnit' | 'Equipment' | 'Power' | 'resource';
const TYPE_ORDER: Record<string, number> = { BattleUnit: 0, Equipment: 1, Power: 2, Trap: 3, CreationUnit: 4, Resource: 5 };
const TYPE_LABEL: Record<string, string> = { BattleUnit: 'Battle Units', Equipment: 'Equipment', Power: 'Power cards', Trap: 'Traps', CreationUnit: 'Creation Units', Resource: 'Resource cards' };

export class DeckBuilder {
  readonly el: HTMLElement;
  private defs: Record<string, CardDef> = currentDefs();
  private deck: StoredDeck;
  private dirty = false;
  private filter: Filter = 'all';
  private unitType = '';
  private query = '';
  private showDisabled = false;
  private preview = new Preview();
  private listEl = h('div', { class: 'db-decks' });
  private poolEl = h('div', { class: 'db-pool', role: 'list', 'aria-label': 'Card pool' });
  private deckEl = h('div', { class: 'db-deck' });
  private filterEl = h('div', { class: 'db-filters' });

  constructor(private onBack: () => void) {
    this.deck = structuredClone(starterDecks[0]!);
    this.el = h('div', { class: 'screen deckbuilder' },
      h('div', { class: 'menu-bg' }),
      h('div', { class: 'db-shell panel' },
        h('div', { class: 'db-head' },
          h('h2', { class: 'h-display' }, 'Deck Builder'),
          h('div', { class: 'db-head-actions' },
            h('button', { class: 'btn', onclick: () => this.newDeck() }, 'New deck'),
            h('button', { class: 'btn', onclick: () => this.importDeck() }, 'Import…'),
            h('button', { class: 'btn ghost', type: 'button', title: 'Back to the main menu (Esc)', onclick: () => this.leave() }, 'Back to menu'))),
        h('div', { class: 'db-body' },
          h('aside', { class: 'db-side' }, h('h3', null, 'Your decks'), this.listEl),
          h('section', { class: 'db-main' }, this.filterEl, this.poolEl),
          h('aside', { class: 'db-right' }, this.deckEl))),
      this.preview.el);
    this.renderAll();
    // Esc leaves too (asks first if there are unsaved changes).
    const onKey = (e: KeyboardEvent) => {
      if (!this.el.isConnected) return document.removeEventListener('keydown', onKey);
      if (e.key === 'Escape' && !this.el.querySelector('.modal')) this.leave();
    };
    document.addEventListener('keydown', onKey);
  }

  private renderAll(): void {
    this.renderList();
    this.renderFilters();
    this.renderPool();
    this.renderDeck();
  }

  // ---------- deck list ----------

  private renderList(): void {
    const item = (d: StoredDeck) => {
      const legal = validateDeck(this.defs, rules, d).length === 0;
      return h('button', { class: `db-deck-item${d.id === this.deck.id ? ' active' : ''}`, onclick: () => this.load(d) },
        h('span', { class: 'db-deck-name' }, d.name),
        h('span', { class: 'db-deck-sub' }, d.starter ? 'starter · read-only' : legal ? 'legal' : 'not legal yet'));
    };
    const custom = customDecks().sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    this.listEl.replaceChildren(
      ...starterDecks.map(item),
      custom.length ? h('div', { class: 'db-sep' }, 'Saved') : h('p', { class: 'faint', style: 'font-size:13px' }, 'Your saved decks appear here.'),
      ...custom.map(item));
  }

  private confirmDiscard(then: () => void): void {
    if (!this.dirty) return then();
    let m: ReturnType<typeof openModal>;
    m = openModal(this.el, 'Discard changes?', `"${this.deck.name}" has unsaved changes.`, null, [
      { label: 'Keep editing', onClick: () => m.close() },
      { label: 'Discard', danger: true, onClick: () => { m.close(); this.dirty = false; then(); } },
    ], { dismissable: true });
  }

  private load(d: StoredDeck): void {
    this.confirmDiscard(() => {
      this.deck = structuredClone(d);
      this.dirty = false;
      this.renderAll();
    });
  }

  private newDeck(): void {
    this.confirmDiscard(() => {
      this.deck = { id: newDeckId(), name: 'New deck', battle: {}, resource: {} };
      this.dirty = true;
      this.renderAll();
    });
  }

  private leave(): void {
    this.confirmDiscard(() => this.onBack());
  }

  // ---------- pool ----------

  private renderFilters(): void {
    const chip = (f: Filter, label: string) => h('button', { class: `btn small${this.filter === f ? ' primary' : ''}`, 'aria-pressed': String(this.filter === f), onclick: () => { this.filter = f; this.renderFilters(); this.renderPool(); } }, label);
    const search = h('input', { class: 'text-input small db-search', placeholder: 'Search cards…', value: this.query, 'aria-label': 'Search cards', oninput: (e: Event) => { this.query = (e.target as HTMLInputElement).value; this.renderPool(); } });
    const unit = h('select', { class: 'text-input small', 'aria-label': 'Unit type', onchange: (e: Event) => { this.unitType = (e.target as HTMLSelectElement).value; this.renderPool(); } },
      ...[['', 'All unit types'], ['Creature', 'Creatures'], ['Robot', 'Robots'], ['Cyborg', 'Cyborgs']].map(([v, l]) => h('option', { value: v, selected: v === this.unitType ? true : undefined }, l)));
    const dis = h('label', { class: 'db-toggle' }, h('input', { type: 'checkbox', checked: this.showDisabled ? true : undefined, onchange: (e: Event) => { this.showDisabled = (e.target as HTMLInputElement).checked; this.renderPool(); } }), 'Show cards not yet enabled');
    this.filterEl.replaceChildren(chip('all', 'All'), chip('BattleUnit', 'Units'), chip('Equipment', 'Equipment'), chip('Power', 'Power & Traps'), chip('resource', 'Resources'), unit, search, dis);
  }

  private poolCards(): CardDef[] {
    const q = this.query.trim().toLowerCase();
    return Object.values(this.defs)
      .filter((d) => this.showDisabled || d.enabled)
      .filter((d) => {
        if (this.filter === 'resource') return d.deck === 'resource';
        if (this.filter === 'Power') return d.cardType === 'Power' || d.cardType === 'Trap';
        if (this.filter !== 'all') return d.cardType === this.filter;
        return true;
      })
      .filter((d) => !this.unitType || d.unitType === this.unitType)
      .filter((d) => !q || d.name.toLowerCase().includes(q) || d.text.toLowerCase().includes(q) || (d.unitType ?? '').toLowerCase().includes(q))
      .sort((a, b) => (TYPE_ORDER[a.cardType]! - TYPE_ORDER[b.cardType]!) || a.name.localeCompare(b.name));
  }

  private renderPool(): void {
    const ro = !!this.deck.starter;
    this.poolEl.replaceChildren(...this.poolCards().map((d) => {
      const list = d.deck === 'battle' ? this.deck.battle : this.deck.resource;
      const n = list[d.id] ?? 0;
      const block = ro ? 'Starter decks are read-only — Duplicate to edit' : !d.enabled ? 'Not enabled yet (no art or still being tuned)' : canAdd(this.defs, rules, this.deck, d.id);
      const card = createCardEl(null, d, { size: 'sm' });
      updateOverlays(card, d);
      card.style.setProperty('--w', '128px');
      card.style.width = '128px';
      const tile = h('button', {
        class: `db-tile${block ? ' blocked' : ''}${n ? ' in-deck' : ''}${!d.enabled ? ' disabled-card' : ''}`,
        role: 'listitem',
        title: block ?? 'Click to add · right-click or Shift+click to remove',
        'aria-label': `${d.name}${n ? `, ${n} in deck` : ''}`,
        onclick: (e: MouseEvent) => (e.shiftKey ? this.change(d.id, -1) : this.change(d.id, +1)),
        oncontextmenu: (e: MouseEvent) => { e.preventDefault(); this.change(d.id, -1); },
        onpointerenter: () => this.preview.show(d, { side: 'right' }),
        onpointerleave: () => this.preview.hide(),
        onfocus: () => this.preview.show(d, { side: 'right' }),
        onblur: () => this.preview.hide(),
      }, card, n ? h('span', { class: 'db-count' }, `×${n}`) : null);
      return tile;
    }));
  }

  private change(id: string, delta: number): void {
    if (this.deck.starter) {
      toast('Starter decks are read-only — click Duplicate to make an editable copy.', 'warn');
      return;
    }
    const d = this.defs[id]!;
    const list = d.deck === 'battle' ? this.deck.battle : this.deck.resource;
    if (delta > 0) {
      if (!d.enabled) return toast(`${d.name} is not enabled yet.`, 'warn');
      const why = canAdd(this.defs, rules, this.deck, id);
      if (why) return toast(why, 'warn');
      list[id] = (list[id] ?? 0) + 1;
    } else {
      if (!list[id]) return;
      list[id]! -= 1;
      if (list[id] === 0) delete list[id];
    }
    this.dirty = true;
    this.renderPool();
    this.renderDeck();
  }

  // ---------- deck panel ----------

  private renderDeck(): void {
    const d = this.deck;
    const ro = !!d.starter;
    const c = deckCounts(this.defs, d);
    const lim = rules.deckLimits;
    const problems = validateDeck(this.defs, rules, d).map((p) => p.message);
    const meter = (label: string, n: number, lo: number, hi: number) =>
      h('div', { class: `db-meter${n < lo || n > hi ? ' bad' : ''}` }, h('span', null, label), h('b', null, `${n}`), h('span', { class: 'faint' }, lo === hi ? `/ ${hi}` : `(${lo}–${hi})`));
    const section = (title: string, entries: [string, number][]) => {
      const groups = new Map<string, [string, number][]>();
      for (const e of entries) {
        const t = this.defs[e[0]]?.cardType ?? 'Other';
        if (!groups.has(t)) groups.set(t, []);
        groups.get(t)!.push(e);
      }
      const rows: Node[] = [h('h3', null, title)];
      for (const [t, list] of [...groups].sort(([a], [b]) => (TYPE_ORDER[a] ?? 9) - (TYPE_ORDER[b] ?? 9))) {
        rows.push(h('div', { class: 'db-group' }, `${TYPE_LABEL[t] ?? t} (${list.reduce((s, [, n]) => s + n, 0)})`));
        for (const [id, n] of list.sort(([a], [b]) => this.defs[a]!.name.localeCompare(this.defs[b]!.name))) {
          const def = this.defs[id]!;
          rows.push(h('div', { class: 'db-row', onpointerenter: () => this.preview.show(def, { side: 'left' }), onpointerleave: () => this.preview.hide() },
            h('span', { class: 'db-row-name' }, def.name),
            ro ? h('span', { class: 'db-row-n' }, `×${n}`) : h('span', { class: 'db-stepper' },
              h('button', { class: 'btn small ghost', 'aria-label': `Remove one ${def.name}`, onclick: () => this.change(id, -1) }, '−'),
              h('span', { class: 'db-row-n' }, String(n)),
              h('button', { class: 'btn small ghost', 'aria-label': `Add one ${def.name}`, onclick: () => this.change(id, +1) }, '+'))));
        }
      }
      if (!entries.length) rows.push(h('p', { class: 'faint', style: 'font-size:13px' }, 'Empty — click cards in the pool to add them.'));
      return rows;
    };
    const name = h('input', { class: 'text-input db-name', value: d.name, maxlength: '40', disabled: ro ? true : undefined, 'aria-label': 'Deck name', oninput: (e: Event) => { d.name = (e.target as HTMLInputElement).value || 'Untitled deck'; this.dirty = true; } });
    this.deckEl.replaceChildren(
      name,
      h('div', { class: 'db-meters' },
        meter('Battle Deck', c.battle, lim.battle.min, lim.battle.max),
        meter('Battle Units', c.units, lim.battle.minBattleUnits, 99),
        meter('Resource Deck', c.resource, lim.resource.min, lim.resource.max),
        meter('Creation Units', c.cus, 0, lim.resource.maxCreationUnits)),
      problems.length
        ? h('div', { class: 'db-problems', role: 'status' }, ...problems.map((p) => h('div', null, `• ${p}`)))
        : h('div', { class: 'db-ok', role: 'status' }, '✓ Legal deck — ready to play'),
      h('div', { class: 'db-actions' },
        ro ? null : h('button', { class: `btn${this.dirty ? ' primary' : ''}`, onclick: () => this.save() }, this.dirty ? 'Save' : 'Saved'),
        h('button', { class: 'btn', onclick: () => this.duplicate() }, 'Duplicate'),
        h('button', { class: 'btn', onclick: () => this.exportDeck() }, 'Export'),
        ro ? null : h('button', { class: 'btn danger', onclick: () => this.remove() }, 'Delete')),
      h('div', { class: 'db-lists' }, ...section('Battle Deck', Object.entries(d.battle)), ...section('Resource Deck', Object.entries(d.resource))),
    );
  }

  private save(): void {
    saveDeck(this.deck);
    this.dirty = false;
    const legal = validateDeck(this.defs, rules, this.deck).length === 0;
    toast(legal ? `Saved "${this.deck.name}". It now appears in every deck menu.` : `Saved "${this.deck.name}". Finish it to make it playable.`);
    this.renderList();
    this.renderDeck();
  }

  private duplicate(): void {
    this.deck = { ...structuredClone(this.deck), id: newDeckId(), name: `${this.deck.name} (copy)`, starter: false };
    this.dirty = true;
    this.renderAll();
  }

  private remove(): void {
    let m: ReturnType<typeof openModal>;
    m = openModal(this.el, `Delete "${this.deck.name}"?`, 'This cannot be undone.', null, [
      { label: 'Cancel', onClick: () => m.close() },
      { label: 'Delete', danger: true, onClick: () => { m.close(); deleteDeck(this.deck.id); this.dirty = false; this.deck = structuredClone(starterDecks[0]!); this.renderAll(); } },
    ], { dismissable: true });
  }

  private exportDeck(): void {
    const blob = new Blob([exportDeckJson(this.deck)], { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `${this.deck.name.replace(/[^\w\- ]+/g, '').trim() || 'deck'}.psi-deck.json` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  private importDeck(): void {
    const area = h('textarea', { class: 'text-input', rows: '8', placeholder: 'Paste deck JSON here, or choose a file below.', style: 'font-family:monospace;font-size:13px' }) as HTMLTextAreaElement;
    const file = h('input', { type: 'file', accept: '.json,application/json', 'aria-label': 'Deck file' }) as HTMLInputElement;
    file.addEventListener('change', async () => {
      const f = file.files?.[0];
      if (f) area.value = await f.text();
    });
    let m: ReturnType<typeof openModal>;
    const go = () => {
      const r = parseDeckImport(area.value, this.defs, rules, newDeckId);
      if (!r.deck) return toast(r.errors.join(' '), 'error', 5000);
      m.close();
      this.confirmDiscard(() => {
        this.deck = r.deck!;
        this.dirty = true;
        this.renderAll();
        const notes = [...r.errors, ...(r.problems.length ? [`${r.problems.length} rule problem(s) to fix before playing.`] : [])];
        toast(notes.length ? `Imported "${r.deck!.name}". ${notes.join(' ')}` : `Imported "${r.deck!.name}" — click Save to keep it.`, notes.length ? 'warn' : 'info', 5000);
      });
    };
    m = openModal(this.el, 'Import a deck', 'Decks exported from Psi Wars (.psi-deck.json) or any { name, battle, resource } JSON.', h('div', { style: 'display:flex;flex-direction:column;gap:10px;width:640px' }, area, file), [
      { label: 'Cancel', onClick: () => m.close() },
      { label: 'Import', primary: true, onClick: go },
    ], { dismissable: true });
  }
}
