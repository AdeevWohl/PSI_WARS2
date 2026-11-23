/**
 * In-game rules reference (§8): the full rule set, searchable, plus pages generated from data so
 * they never drift — House Rules (build prompt §3, with their config constants), the rulings
 * index and the card reference.
 */
import rulebookMd from '@data/rulebook.md?raw';
import { currentDefs, rules, rulings } from '../data';
import { h } from './dom';

interface Section {
  id: string;
  title: string;
  md: string;
}

const HOUSE_CONSTANTS: Record<string, string[]> = {
  'HR-A': ['MP_ATTACK_TARGETING'],
  'HR-B': ['MP_BLOCKING'],
  'HR-C': ['MP_POWER_WINDOW_ORDER'],
  'HR-D': ['MP_ELIMINATION'],
  'HR-E': ['MP_OPPONENT_MEANS'],
  'HR-F': ['MP_TEAMS'],
  'HR-G': ['MP_FIRST_TURN'],
  'HR-J': ['TURN_TIMER_SEC'],
  'HR-K': ['TRAP_RESPONSES'],
  'HR-L': ['INSTANT_SCOPE'],
  'HR-M': ['TRAP_WINDOW_MS', 'FAST_WINDOWS'],
};

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function generated(): Section[] {
  const hr = Object.entries(rulings.rulings).filter(([id]) => id.startsWith('HR-'));
  const house = [
    'These Round 2 defaults from the Pre-Build Q&A apply until the design team decides otherwise. Each one sits behind a named setting in `data/rules.json`, so it can be flipped without code changes. Online modes, hosting, timers and the balance tools (Round 2 items H, I, N) are features rather than rules: online play with room codes, hot-seat and computer seats; local server + tunnel or Cloudflare; an optional turn timer; the card editor, game-log export and simulator.',
    '',
    '| Rule | What it says | Setting (current value) |',
    '|---|---|---|',
    ...hr.map(([id, r]) => `| **${id.replace('HR-', '')}. ${r.title}** | ${r.text} | ${(HOUSE_CONSTANTS[id] ?? []).map((k) => `\`${k}\` = ${String(rules.houseRules[k])}`).join('<br>') || '—'} |`),
  ].join('\n');
  const ids = Object.entries(rulings.rulings).filter(([id]) => !id.startsWith('HR-'));
  const index = [
    'Rulings from the Rules & Game Spec (marked RULING) and the Pre-Build Q&A overrides. Q&A answers win over the spec where they differ.',
    '',
    '| ID | Topic | Ruling |',
    '|---|---|---|',
    ...ids.map(([id, r]) => `| ${id} | ${r.title} | ${r.text} |`),
  ].join('\n');
  const defs = Object.values(currentDefs()).filter((d) => d.enabled).sort((a, b) => a.cardType.localeCompare(b.cardType) || a.name.localeCompare(b.name));
  const cost = (c?: { G: number; B: number; R: number; P: number; W: number }) => (c ? (['G', 'B', 'R', 'P', 'W'] as const).filter((k) => c[k]).map((k) => `${k}${c[k]}`).join(' ') || '—' : '—');
  const stats = (d: (typeof defs)[number]) => (d.stats ? `Cy ${d.stats.cyber} · Ps ${d.stats.psionic} · Ph ${d.stats.physical}` : d.equip ? `+${d.equip.bonus} ${d.equip.ability}` : '');
  const cards = [
    'Every enabled card with its current (balanced) values. Cost letters: G Digital Splicing, B Neurogenesis, R Bio-Acceleration, P Material Animation, W Creation Units to destroy.',
    '',
    '| Card | Type | Cost | Strengths | Text |',
    '|---|---|---|---|---|',
    ...defs.map((d) => `| **${d.name}** | ${d.cardType === 'BattleUnit' ? `${d.unitType}${d.isCommander ? ' Commander' : ''}` : d.cardType} | ${cost(d.cost)} | ${stats(d)} | ${d.text || '—'} |`),
  ].join('\n');
  return [
    { id: 'house-rules', title: 'House rules', md: house },
    { id: 'rulings', title: 'Rulings index', md: index },
    { id: 'cards', title: 'Card reference', md: cards },
  ];
}

export function rulebookSections(): Section[] {
  const out: Section[] = [];
  let cur: Section | null = null;
  for (const line of rulebookMd.split(/\r?\n/)) {
    const m = line.match(/^# (.+)$/);
    if (m) {
      cur = { id: slug(m[1]!), title: m[1]!, md: '' };
      out.push(cur);
    } else if (cur) cur.md += line + '\n';
  }
  return [...out, ...generated()];
}

// ---------- tiny markdown renderer (headings, lists, tables, bold/italic/code) ----------

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function inline(s: string, q: string): string {
  let out = esc(s)
    .replace(/&lt;br&gt;/g, '<br>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code>$1</code>');
  if (q) {
    const re = new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})(?![^<]*>)`, 'gi');
    out = out.replace(re, '<mark>$1</mark>');
  }
  return out;
}

/** Render markdown; with a query, keep only blocks (paragraphs, list items, table rows) that match. */
function render(md: string, q: string): { html: string; hits: number } {
  const lines = md.split('\n');
  const parts: string[] = [];
  let hits = 0;
  const matches = (t: string) => !q || t.toLowerCase().includes(q.toLowerCase());
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }
    if (line.startsWith('|')) {
      const rows: string[] = [];
      while (i < lines.length && lines[i]!.startsWith('|')) rows.push(lines[i++]!);
      const cells = (r: string) => r.slice(1, r.endsWith('|') ? -1 : undefined).split('|').map((c) => c.trim());
      const head = cells(rows[0]!);
      const body = rows.slice(2).filter((r) => matches(r));
      hits += q ? body.length : 0;
      if (body.length) parts.push(`<table><thead><tr>${head.map((c) => `<th>${inline(c, '')}</th>`).join('')}</tr></thead><tbody>${body.map((r) => `<tr>${cells(r).map((c) => `<td>${inline(c, q)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
      continue;
    }
    if (/^(- |\d+\. )/.test(line)) {
      const ordered = /^\d+\. /.test(line);
      const items: string[] = [];
      while (i < lines.length && /^(- |\d+\. )/.test(lines[i]!)) items.push(lines[i++]!.replace(/^(- |\d+\. )/, ''));
      const keep = items.filter(matches);
      hits += q ? keep.length : 0;
      if (keep.length) parts.push(`<${ordered ? 'ol' : 'ul'}>${keep.map((t) => `<li>${inline(t, q)}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !lines[i]!.startsWith('|') && !/^(- |\d+\. )/.test(lines[i]!)) para.push(lines[i++]!);
    const text = para.join(' ');
    if (matches(text)) {
      hits += q ? 1 : 0;
      const ruling = /^\*\*(RULING|House rule)/.test(text);
      parts.push(`<p${ruling ? ' class="ruling"' : ''}>${inline(text, q)}</p>`);
    }
  }
  return { html: parts.join(''), hits };
}

export function rulesReference(onClose: (() => void) | null, startAt?: string): HTMLElement {
  const sections = rulebookSections();
  const nav = h('nav', { class: 'rr-nav', 'aria-label': 'Rule sections' });
  const content = h('div', { class: 'rr-content', tabindex: '0' });
  const count = h('div', { class: 'rr-count dim' });
  const search = h('input', { class: 'text-input rr-search', type: 'search', placeholder: 'Search the rules (e.g. obliterate, stack, trap)…', 'aria-label': 'Search the rules' }) as HTMLInputElement;
  let current = startAt ?? sections[0]!.id;

  const show = () => {
    const q = search.value.trim();
    if (q.length >= 2) {
      let total = 0;
      const blocks: Node[] = [];
      for (const s of sections) {
        const r = render(s.md, q);
        if (!r.hits && !s.title.toLowerCase().includes(q.toLowerCase())) continue;
        total += r.hits;
        const sec = h('section', { class: 'rr-section' }, h('h2', null, s.title));
        sec.insertAdjacentHTML('beforeend', r.html);
        blocks.push(sec);
      }
      count.textContent = total ? `${total} match${total === 1 ? '' : 'es'} in ${blocks.length} section${blocks.length === 1 ? '' : 's'}` : 'No matches.';
      content.replaceChildren(...blocks);
      nav.querySelectorAll('button').forEach((b) => b.classList.remove('active'));
      return;
    }
    count.textContent = '';
    const s = sections.find((x) => x.id === current) ?? sections[0]!;
    const sec = h('section', { class: 'rr-section' }, h('h2', null, s.title));
    sec.insertAdjacentHTML('beforeend', render(s.md, '').html);
    content.replaceChildren(sec);
    content.scrollTop = 0;
    nav.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.id === s.id));
  };
  nav.append(...sections.map((s) => h('button', { class: 'rr-link', dataset: { id: s.id }, onclick: () => { current = s.id; search.value = ''; show(); } }, s.title)));
  search.addEventListener('input', show);
  show();
  requestAnimationFrame(() => search.focus({ preventScroll: true }));
  return h('div', { class: 'rules-ref' },
    h('div', { class: 'rr-head' }, h('h2', { class: 'h-display' }, 'Rules reference'), search, onClose ? h('button', { class: 'btn', onclick: onClose }, 'Close') : null),
    count,
    h('div', { class: 'rr-body' }, nav, content));
}
