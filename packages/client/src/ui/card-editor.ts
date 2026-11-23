/**
 * In-game card editor (build prompt §13): edit costs, strengths, Equipment bonuses, ability
 * values and rules text live, with a card preview. Saves a balance file layered over cards.json
 * (applied to new local games, the deck builder and the rules reference; hosts can use it online),
 * exports/imports it to share, resets to cards.json or to the printed values, and runs a quick
 * AI-vs-AI simulation to measure the change. Reached from the developer menu.
 */
import { BALANCE_FORMAT, BALANCE_LIMITS, PARAM_OPTIONS, buildDefs, cleanBalance, describeOverlay, diffCard, validateDeck, type AiLevel, type BalanceFile, type CardDef, type CardOverlay } from '@psi-wars/engine';
import { activeBalance, balancePresets, downloadJson, setActiveBalance, slugify } from '../balance';
import { baseCards, rules, starterDecks } from '../data';
import { createCardEl, updateOverlays } from '../render/card';
import type { SimMessage, SimRequest } from '../sim.worker';
import { h, toast } from './dom';
import { openModal } from './modals';

const TYPE_LABEL: Record<string, string> = { BattleUnit: 'Battle Unit', Equipment: 'Equipment', Power: 'Power', Trap: 'Trap', CreationUnit: 'Creation Unit', Resource: 'Resource' };
const TYPE_ORDER: Record<string, number> = { BattleUnit: 0, Equipment: 1, Power: 2, Trap: 3, Resource: 4, CreationUnit: 5 };
const COSTS = [['G', 'Digital Splicing (green)'], ['B', 'Neurogenesis (blue)'], ['R', 'Bio-Acceleration (red)'], ['P', 'Material Animation (purple)'], ['W', 'Creation Units to destroy']] as const;
const STATS = [['cyber', 'Cyber'], ['psionic', 'Psionic'], ['physical', 'Physical']] as const;
const UNIT_TYPES = ['Creature', 'Robot', 'Cyborg'] as const;

export class CardEditor {
  readonly el: HTMLElement;
  private base = buildDefs(baseCards);
  private work: Record<string, CardDef>;
  private name: string;
  private notes: string;
  private selected: string;
  private dirty = false;
  private query = '';
  private type = '';
  private changedOnly = false;
  private listEl = h('div', { class: 'ce-list', role: 'listbox', 'aria-label': 'Cards' });
  private formEl = h('div', { class: 'ce-form' });
  private previewEl = h('div', { class: 'ce-preview' });
  private summaryEl = h('div', { class: 'ce-summary' });
  private simEl = h('div', { class: 'ce-sim' });
  private saveBtn = h('button', { class: 'btn', onclick: () => this.save() }, 'Saved');
  private nameInput: HTMLInputElement;
  private worker: Worker | null = null;

  constructor(private onBack: () => void) {
    const active = activeBalance();
    this.work = buildDefs(baseCards, active ?? undefined);
    this.name = active?.name ?? 'My balance';
    this.notes = active?.notes ?? '';
    this.selected = this.sortedIds()[0]!;
    this.nameInput = h('input', { class: 'text-input small ce-name', value: this.name, maxlength: '60', 'aria-label': 'Balance name', oninput: (e: Event) => { this.name = (e.target as HTMLInputElement).value; this.touch(); } }) as HTMLInputElement;
    const presets = balancePresets();
    const presetSel = h('select', { class: 'text-input small', 'aria-label': 'Load a preset', onchange: (e: Event) => {
      const sel = e.target as HTMLSelectElement;
      const p = presets.find((x) => x.file === sel.value);
      sel.value = '';
      if (p) this.confirm(() => this.loadBalance(p.balance, p.errors, `Loaded preset ${p.file}`));
    } }, h('option', { value: '' }, presets.length ? 'Load preset…' : 'No presets in data/balance'), ...presets.map((p) => h('option', { value: p.file }, p.balance.name)));
    this.el = h('div', { class: 'screen card-editor' },
      h('div', { class: 'menu-bg' }),
      h('div', { class: 'ce-shell panel' },
        h('div', { class: 'ce-head' },
          h('h2', { class: 'h-display' }, 'Card editor'),
          this.nameInput,
          h('div', { class: 'ce-head-actions' },
            presetSel,
            h('button', { class: 'btn', onclick: () => this.importBalance() }, 'Import…'),
            h('button', { class: 'btn', onclick: () => this.exportBalance() }, 'Export'),
            h('button', { class: 'btn ghost', onclick: () => this.confirm(() => this.resetAll(), 'Reset every card to cards.json?', 'Reset all') }, 'Reset all'),
            this.saveBtn,
            h('button', { class: 'btn ghost', onclick: () => this.leave() }, 'Back'))),
        h('div', { class: 'ce-body' },
          h('aside', { class: 'ce-side' }, this.filters(), this.listEl),
          h('section', { class: 'ce-main' }, this.formEl),
          h('aside', { class: 'ce-right' }, this.previewEl, this.summaryEl, this.simEl))));
    this.renderAll();
    this.renderSim();
  }

  destroy(): void {
    this.worker?.terminate();
  }

  // ---------- state ----------

  private overlays(): Record<string, CardOverlay> {
    const out: Record<string, CardOverlay> = {};
    for (const id of Object.keys(this.base)) {
      const o = diffCard(this.base[id]!, this.work[id]!);
      if (Object.keys(o).length) out[id] = o;
    }
    return out;
  }

  private balanceFile(): BalanceFile {
    return { format: BALANCE_FORMAT, version: 1, name: this.name.trim() || 'My balance', ...(this.notes ? { notes: this.notes } : {}), cards: this.overlays() };
  }

  private touch(): void {
    this.dirty = true;
    this.saveBtn.textContent = 'Save & apply';
    this.saveBtn.classList.add('primary');
  }

  private sortedIds(): string[] {
    return Object.values(this.base).sort((a, b) => (TYPE_ORDER[a.cardType] ?? 9) - (TYPE_ORDER[b.cardType] ?? 9) || a.name.localeCompare(b.name)).map((d) => d.id);
  }

  private changed(id: string): boolean {
    return Object.keys(diffCard(this.base[id]!, this.work[id]!)).length > 0;
  }

  private loadBalance(b: BalanceFile | null, errors: string[], message: string): void {
    this.work = buildDefs(baseCards, b ?? undefined);
    this.name = b?.name ?? 'My balance';
    this.notes = b?.notes ?? '';
    this.nameInput.value = this.name;
    this.touch();
    this.renderAll();
    toast(errors.length ? `${message} — ${errors.length} problem(s) ignored` : message, errors.length ? 'warn' : 'info', errors.length ? 6000 : 2500);
    if (errors.length) console.warn('balance problems', errors);
  }

  private resetAll(): void {
    this.loadBalance(null, [], 'All cards reset to cards.json');
  }

  private save(): void {
    const { balance, errors } = cleanBalance(baseCards, this.balanceFile());
    if (errors.length) {
      toast(`Fix ${errors.length} problem(s) first: ${errors[0]}`, 'error', 6000);
      return;
    }
    setActiveBalance(balance);
    this.dirty = false;
    this.saveBtn.textContent = 'Saved';
    this.saveBtn.classList.remove('primary');
    const n = Object.keys(balance.cards).length;
    toast(n ? `Saved "${balance.name}" (${n} card${n === 1 ? '' : 's'} changed). New games use it.` : 'No changes: new games use the standard cards.', 'info', 3500);
    this.renderSummary();
  }

  private confirm(then: () => void, title = 'Discard unsaved changes?', label = 'Discard'): void {
    if (!this.dirty && title === 'Discard unsaved changes?') return then();
    let m: ReturnType<typeof openModal>;
    m = openModal(this.el, title, null, null, [
      { label: 'Cancel', onClick: () => m.close() },
      { label, danger: true, onClick: () => { m.close(); then(); } },
    ], { dismissable: true });
  }

  private leave(): void {
    this.confirm(() => this.onBack());
  }

  private exportBalance(): void {
    const b = this.balanceFile();
    downloadJson(b, `psi-wars-balance-${slugify(b.name)}.json`);
  }

  private importBalance(): void {
    const area = h('textarea', { class: 'text-input', rows: '10', style: 'width:100%;font-family:monospace;font-size:13px', placeholder: 'Paste a balance file here, or choose a file…' }) as HTMLTextAreaElement;
    const file = h('input', { type: 'file', accept: '.json,application/json', onchange: async (e: Event) => {
      const f = (e.target as HTMLInputElement).files?.[0];
      if (f) area.value = await f.text();
    } });
    let m: ReturnType<typeof openModal>;
    m = openModal(this.el, 'Import a balance file', 'Exported from this editor or found in data/balance. It replaces the cards currently in the editor.', h('div', null, file, area), [
      { label: 'Cancel', onClick: () => m.close() },
      { label: 'Import', primary: true, onClick: () => {
        let raw: unknown;
        try {
          raw = JSON.parse(area.value);
        } catch {
          return toast('That is not valid JSON.', 'error');
        }
        const { balance, errors } = cleanBalance(baseCards, raw);
        if (errors.length && !Object.keys(balance.cards).length) return toast(errors[0]!, 'error', 6000);
        m.close();
        this.confirm(() => this.loadBalance(balance, errors, `Imported "${balance.name}"`));
      } },
    ], { dismissable: true, className: 'ce-import' });
  }

  // ---------- rendering ----------

  private renderAll(): void {
    this.renderList();
    this.renderForm();
    this.renderPreview();
    this.renderSummary();
  }

  private filters(): HTMLElement {
    return h('div', { class: 'ce-filters' },
      h('input', { class: 'text-input small', type: 'search', placeholder: 'Search cards…', 'aria-label': 'Search cards', oninput: (e: Event) => { this.query = (e.target as HTMLInputElement).value.toLowerCase(); this.renderList(); } }),
      h('select', { class: 'text-input small', 'aria-label': 'Card type', onchange: (e: Event) => { this.type = (e.target as HTMLSelectElement).value; this.renderList(); } },
        h('option', { value: '' }, 'All types'), ...Object.entries(TYPE_LABEL).map(([v, l]) => h('option', { value: v }, l))),
      h('label', { class: 'db-toggle' }, h('input', { type: 'checkbox', onchange: (e: Event) => { this.changedOnly = (e.target as HTMLInputElement).checked; this.renderList(); } }), 'Changed only'));
  }

  private renderList(): void {
    const items = this.sortedIds().filter((id) => {
      const d = this.work[id]!;
      if (this.type && d.cardType !== this.type) return false;
      if (this.changedOnly && !this.changed(id)) return false;
      return !this.query || d.name.toLowerCase().includes(this.query) || d.text.toLowerCase().includes(this.query);
    });
    this.listEl.replaceChildren(...items.map((id) => {
      const d = this.work[id]!;
      return h('button', { class: `ce-item${id === this.selected ? ' active' : ''}${d.enabled ? '' : ' off'}`, role: 'option', 'aria-selected': String(id === this.selected), onclick: () => { this.selected = id; this.renderAll(); } },
        h('span', { class: 'ce-item-name' }, d.name, this.changed(id) ? h('span', { class: 'ce-dot', title: 'Changed' }, ' ●') : null),
        h('span', { class: 'ce-item-sub' }, `${TYPE_LABEL[d.cardType]}${d.unitType ? ` · ${d.unitType}` : ''}${d.enabled ? '' : ' · not enabled'}`));
    }));
    if (!items.length) this.listEl.append(h('p', { class: 'faint' }, 'No cards match.'));
  }

  /** Apply an edit to the selected card and refresh what depends on it (not the focused form). */
  private edit(fn: (d: CardDef) => void): void {
    fn(this.work[this.selected]!);
    this.touch();
    this.renderPreview();
    this.renderSummary();
    this.renderList();
    this.formEl.querySelector('.ce-card-state')?.replaceWith(this.cardState());
  }

  private cardState(): HTMLElement {
    const o = diffCard(this.base[this.selected]!, this.work[this.selected]!);
    const parts = describeOverlay(this.base[this.selected]!, o);
    return h('div', { class: `ce-card-state${parts.length ? ' changed' : ''}` }, parts.length ? `Changed: ${parts.join('; ')}` : 'Same as cards.json');
  }

  private num(value: number, min: number, max: number, onValue: (n: number) => void, label: string): HTMLElement {
    const input = h('input', { class: 'text-input small ce-num', type: 'number', min: String(min), max: String(max), step: '1', value: String(value), 'aria-label': label }) as HTMLInputElement;
    input.addEventListener('input', () => {
      const n = Number(input.value);
      const ok = input.value !== '' && Number.isInteger(n) && n >= min && n <= max;
      input.classList.toggle('bad', !ok);
      if (ok) onValue(n);
    });
    return input;
  }

  private renderForm(): void {
    const id = this.selected;
    const d = this.work[id]!;
    const b = this.base[id]!;
    const sections: (HTMLElement | null)[] = [];
    const printedDiffers = !!d.printed && ((d.printed.cost && JSON.stringify(d.printed.cost) !== JSON.stringify(d.cost)) || (d.printed.stats && JSON.stringify(d.printed.stats) !== JSON.stringify(d.stats)));
    sections.push(h('div', { class: 'ce-title' },
      h('div', null, h('h3', null, d.name), h('div', { class: 'dim' }, `${TYPE_LABEL[d.cardType]}${d.unitType ? ` · ${d.unitType}${d.isCommander ? ' Commander' : ''}` : ''} · id ${d.id}`)),
      h('div', { class: 'ce-title-actions' },
        printedDiffers ? h('button', { class: 'btn small', title: 'Use the numbers printed on the card art', onclick: () => { this.edit((x) => { if (x.printed?.cost) x.cost = structuredClone(x.printed.cost); if (x.printed?.stats) x.stats = structuredClone(x.printed.stats); }); this.renderForm(); } }, 'Use printed values') : null,
        h('button', { class: 'btn small ghost', onclick: () => { this.work[id] = structuredClone(b); this.touch(); this.renderAll(); } }, 'Reset card'))));
    sections.push(this.cardState());
    sections.push(this.field('Enabled', h('input', { type: 'checkbox', class: 'toggle', checked: d.enabled ? true : undefined, onchange: (e: Event) => this.edit((x) => (x.enabled = (e.target as HTMLInputElement).checked)) }), 'Disabled cards cannot be put in decks.'));

    if (d.cost) {
      sections.push(h('h4', null, 'Cost'));
      sections.push(h('div', { class: 'ce-grid' }, ...COSTS.map(([k, label]) =>
        h('label', { class: `ce-cell cost-${k}` }, h('span', null, label, b.cost && b.cost[k] !== d.cost![k] ? h('span', { class: 'ce-was' }, ` (was ${b.cost[k]})`) : null),
          this.num(d.cost![k], BALANCE_LIMITS.cost.min, BALANCE_LIMITS.cost.max, (n) => this.edit((x) => (x.cost![k] = n)), label)))));
    }
    if (d.stats) {
      sections.push(h('h4', null, 'Strengths'));
      sections.push(h('div', { class: 'ce-grid' }, ...STATS.map(([k, label]) => {
        const input = h('input', { class: 'text-input small ce-num', value: String(d.stats![k]), 'aria-label': label, title: `0–${BALANCE_LIMITS.stat.max}, or X (rolled)` }) as HTMLInputElement;
        input.addEventListener('input', () => {
          const v = input.value.trim().toUpperCase();
          const n = Number(v);
          const ok = v === 'X' || (v !== '' && Number.isInteger(n) && n >= 0 && n <= BALANCE_LIMITS.stat.max);
          input.classList.toggle('bad', !ok);
          if (ok) this.edit((x) => (x.stats![k] = v === 'X' ? 'X' : n));
        });
        return h('label', { class: `ce-cell stat-${k}` }, h('span', null, label, b.stats && b.stats[k] !== d.stats![k] ? h('span', { class: 'ce-was' }, ` (was ${b.stats[k]})`) : null), input);
      })));
      sections.push(h('p', { class: 'faint ce-note' }, 'X means the strength is rolled (see the card’s ability).'));
    }
    if (d.equip) {
      const eq = d.equip;
      sections.push(h('h4', null, 'Equipment'));
      sections.push(h('div', { class: 'ce-grid' },
        h('label', { class: 'ce-cell' }, h('span', null, 'Boosts'), h('select', { class: 'text-input small', onchange: (e: Event) => this.edit((x) => (x.equip!.ability = (e.target as HTMLSelectElement).value as typeof eq.ability)) }, ...STATS.map(([k, l]) => h('option', { value: k, selected: eq.ability === k ? true : undefined }, l)))),
        h('label', { class: 'ce-cell' }, h('span', null, 'Bonus', b.equip && b.equip.bonus !== eq.bonus ? h('span', { class: 'ce-was' }, ` (was +${b.equip.bonus})`) : null), this.num(eq.bonus, BALANCE_LIMITS.bonus.min, BALANCE_LIMITS.bonus.max, (n) => this.edit((x) => (x.equip!.bonus = n)), 'Bonus')),
        h('div', { class: 'ce-cell' }, h('span', null, 'Can equip'), h('div', { class: 'ce-checks' }, ...UNIT_TYPES.map((t) => h('label', null, h('input', { type: 'checkbox', checked: eq.allowed.includes(t) ? true : undefined, onchange: (e: Event) => {
          const on = (e.target as HTMLInputElement).checked;
          const next = on ? [...new Set([...eq.allowed, t])] : eq.allowed.filter((x) => x !== t);
          if (!next.length) {
            (e.target as HTMLInputElement).checked = true;
            return toast('Equipment must fit at least one unit type.', 'warn');
          }
          this.edit((x) => (x.equip!.allowed = UNIT_TYPES.filter((u) => next.includes(u))));
        } }), ` ${t}`))))));
    }
    if (d.effects.length) {
      sections.push(h('h4', null, 'Ability values'));
      d.effects.forEach((ef, i) => {
        const params = this.paramFields(ef.params, b.effects[i]?.params ?? {}, (fn) => this.edit((x) => fn(x.effects[i]!.params)));
        sections.push(h('div', { class: 'ce-effect' }, h('div', { class: 'ce-effect-name' }, ef.effect, h('span', { class: 'dim' }, ` · when: ${ef.trigger}`)), params.length ? h('div', { class: 'ce-grid' }, ...params) : h('div', { class: 'faint' }, 'No adjustable values.')));
      });
    }
    sections.push(h('h4', null, 'Rules text'));
    const text = h('textarea', { class: 'text-input ce-text', rows: '4', maxlength: String(BALANCE_LIMITS.text), 'aria-label': 'Rules text' }) as HTMLTextAreaElement;
    text.value = d.text;
    text.addEventListener('input', () => this.edit((x) => (x.text = text.value)));
    sections.push(text);
    sections.push(h('p', { class: 'faint ce-note' }, 'The text printed on the card art cannot change; edited text appears in the card zoom, tooltips and the rules reference. Changed numbers show as coloured chips on the card.'));
    if (d.implementation) sections.push(h('p', { class: 'faint ce-note' }, `How the engine reads it: ${d.implementation}`));
    this.formEl.replaceChildren(...sections.filter(Boolean) as HTMLElement[]);
  }

  /** Inputs for an ability's parameters: numbers, on/off options and known choices; others are shown read-only. */
  private paramFields(p: Record<string, unknown>, base: Record<string, unknown>, apply: (fn: (target: Record<string, unknown>) => void) => void, prefix = ''): HTMLElement[] {
    const out: HTMLElement[] = [];
    for (const [k, v] of Object.entries(p)) {
      const label = `${prefix}${k}`;
      const was = base[k];
      const wasNote = was !== undefined && JSON.stringify(was) !== JSON.stringify(v) && typeof v !== 'object' ? h('span', { class: 'ce-was' }, ` (was ${String(was)})`) : null;
      if (typeof v === 'number') {
        out.push(h('label', { class: 'ce-cell' }, h('span', null, label, wasNote), this.num(v, BALANCE_LIMITS.param.min, BALANCE_LIMITS.param.max, (n) => apply((t) => (t[k] = n)), label)));
      } else if (typeof v === 'boolean') {
        out.push(h('label', { class: 'ce-cell' }, h('span', null, label, wasNote), h('input', { type: 'checkbox', class: 'toggle', checked: v ? true : undefined, onchange: (e: Event) => apply((t) => (t[k] = (e.target as HTMLInputElement).checked)) })));
      } else if (typeof v === 'string' && PARAM_OPTIONS[k]?.includes(v)) {
        out.push(h('label', { class: 'ce-cell' }, h('span', null, label, wasNote), h('select', { class: 'text-input small', onchange: (e: Event) => apply((t) => (t[k] = (e.target as HTMLSelectElement).value)) }, ...PARAM_OPTIONS[k]!.map((o) => h('option', { value: o, selected: o === v ? true : undefined }, o)))));
      } else if (v && typeof v === 'object' && !Array.isArray(v)) {
        out.push(...this.paramFields(v as Record<string, unknown>, (base[k] as Record<string, unknown>) ?? {}, (fn) => apply((t) => fn(t[k] as Record<string, unknown>)), `${label}.`));
      } else {
        out.push(h('div', { class: 'ce-cell fixed', title: 'Fixed: part of what the ability does' }, h('span', null, label), h('code', null, Array.isArray(v) ? v.join(', ') : String(v))));
      }
    }
    return out;
  }

  private renderPreview(): void {
    const d = this.work[this.selected]!;
    const card = createCardEl(null, d, { size: 'md' });
    updateOverlays(card, d);
    card.style.setProperty('--w', '300px');
    const legal = starterDecks.map((s) => ({ s, problems: validateDeck(this.work, rules, s) }));
    this.previewEl.replaceChildren(card,
      h('p', { class: 'ce-preview-text' }, d.text || h('span', { class: 'faint' }, 'No rules text.')),
      ...legal.filter((x) => x.problems.length).map((x) => h('p', { class: 'ce-warn' }, `${x.s.name} is not a legal deck with these cards: ${x.problems[0]!.message}`)));
  }

  private renderSummary(): void {
    const o = this.overlays();
    const active = activeBalance();
    const rows = Object.entries(o).map(([id, ov]) => h('button', { class: 'ce-sum-row', onclick: () => { this.selected = id; this.renderAll(); } }, h('b', null, this.base[id]!.name), h('span', { class: 'dim' }, ` ${describeOverlay(this.base[id]!, ov).join('; ')}`)));
    this.summaryEl.replaceChildren(
      h('h4', null, `This balance: ${rows.length} card${rows.length === 1 ? '' : 's'} changed`),
      h('div', { class: 'dim', style: 'font-size:13px;margin-bottom:6px' }, active ? `In force for new games: "${active.name}"${this.dirty ? ' (unsaved edits here)' : ''}` : `In force for new games: standard cards${this.dirty ? ' (unsaved edits here)' : ''}`),
      ...(rows.length ? rows : [h('p', { class: 'faint' }, 'No changes yet — pick a card on the left.')]));
  }

  // ---------- quick simulation ----------

  private renderSim(): void {
    const games = h('select', { class: 'text-input small', 'aria-label': 'Games' }, ...[100, 300, 1000].map((n) => h('option', { value: String(n), selected: n === 300 ? true : undefined }, `${n} games`))) as HTMLSelectElement;
    const ai = h('select', { class: 'text-input small', 'aria-label': 'AI level' }, ...['easy', 'normal', 'hard'].map((l) => h('option', { value: l, selected: l === 'normal' ? true : undefined }, `${l[0]!.toUpperCase()}${l.slice(1)} AI`))) as HTMLSelectElement;
    const compare = h('input', { type: 'checkbox', checked: true }) as HTMLInputElement;
    const out = h('div', { class: 'ce-sim-out' });
    const bar = h('div', { class: 'ce-progress' }, h('div', { class: 'ce-progress-fill' }));
    const run = h('button', { class: 'btn small primary' }, 'Run') as HTMLButtonElement;
    run.addEventListener('click', () => {
      if (this.worker) {
        this.worker.terminate();
        this.worker = null;
        run.textContent = 'Run';
        bar.classList.remove('on');
        return;
      }
      const decks = starterDecks.filter((s) => validateDeck(this.work, rules, s).length === 0).map((s) => ({ name: s.name, deck: { battle: s.battle, resource: s.resource } }));
      if (!decks.length) return toast('No starter deck is legal with these cards.', 'error');
      const req: SimRequest = {
        runs: [{ label: 'This balance', defs: this.work, balanceName: this.name }, ...(compare.checked ? [{ label: 'Standard cards', defs: this.base, balanceName: 'cards.json' }] : [])],
        rules, decks, games: Number(games.value), ai: ai.value as AiLevel, seed: 'editor',
      };
      const w = new Worker(new URL('../sim.worker.ts', import.meta.url), { type: 'module' });
      this.worker = w;
      run.textContent = 'Stop';
      bar.classList.add('on');
      out.replaceChildren(h('div', { class: 'dim' }, 'Simulating…'));
      w.onmessage = (e: MessageEvent<SimMessage>) => {
        const m = e.data;
        if (m.t === 'progress') {
          const frac = (m.run + m.done / m.total) / req.runs.length;
          (bar.firstChild as HTMLElement).style.transform = `scaleX(${frac})`;
          return;
        }
        w.terminate();
        this.worker = null;
        run.textContent = 'Run';
        bar.classList.remove('on');
        if (m.t === 'error') return void out.replaceChildren(h('div', { class: 'ce-warn' }, `Simulation failed: ${m.message}`));
        out.replaceChildren(this.simResult(m.reports));
      };
      w.postMessage(req);
    });
    this.simEl.replaceChildren(
      h('h4', null, 'Quick test (computer vs computer)'),
      h('div', { class: 'ce-sim-controls' }, games, ai, h('label', { class: 'db-toggle' }, compare, 'compare with standard'), run),
      bar, out,
      h('p', { class: 'faint ce-note' }, 'Uses the cards as edited here (saved or not), both starter decks, seats alternated. For big runs: npm run sim -- --balance <exported file>.'));
  }

  private simResult(reports: { label: string; report: import('@psi-wars/engine').SimReport; text: string }[]): HTMLElement {
    const deckNames = reports[0]!.report.decks.map((d) => d.name);
    const table = h('table', { class: 'ce-sim-table' },
      h('tr', null, h('th', null, ''), ...reports.map((r) => h('th', null, r.label))),
      ...deckNames.map((name) => h('tr', null, h('td', null, name), ...reports.map((r) => {
        const d = r.report.decks.find((x) => x.name === name);
        return h('td', null, d ? `${(d.winRate * 100).toFixed(1)}%` : '—');
      }))),
      h('tr', null, h('td', null, 'Avg. turns'), ...reports.map((r) => h('td', null, r.report.length.avgTurns.toFixed(1)))),
      h('tr', null, h('td', null, 'First player wins'), ...reports.map((r) => h('td', null, `${(r.report.firstPlayer.winRate * 100).toFixed(1)}%`))),
      h('tr', null, h('td', null, 'First unit destroyed'), ...reports.map((r) => h('td', null, r.report.firstDestroyed[0] ? `${r.report.firstDestroyed[0].name} (${(r.report.firstDestroyed[0].share * 100).toFixed(0)}%)` : '—'))));
    const full = h('details', null, h('summary', null, 'Full report'), h('pre', { class: 'ce-sim-pre' }, reports.map((r) => `== ${r.label} ==\n${r.text}`).join('\n\n')));
    const save = h('button', { class: 'btn small ghost', onclick: () => downloadJson(reports.map((r) => ({ label: r.label, ...r.report })), `psi-wars-sim-${slugify(this.name)}.json`) }, 'Download report');
    return h('div', null, table, h('div', { class: 'row', style: 'justify-content:flex-start;margin-top:6px' }, save), full);
  }

  private field(label: string, control: HTMLElement, hint?: string): HTMLElement {
    return h('div', { class: 'set-row' }, h('label', { class: 'set-label' }, label, hint ? h('span', { class: 'set-hint' }, hint) : null), control);
  }
}
