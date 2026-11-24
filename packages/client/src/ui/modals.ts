import type { Payment } from '@psi-wars/shared';
import type { CardDef, GameView, LegalView } from '@psi-wars/engine';
import { createCardEl, updateOverlays } from '../render/card';
import { h } from './dom';

export interface ModalHandle {
  close(): void;
  el: HTMLElement;
}

export function openModal(host: HTMLElement, title: string, sub: string | null, body: Node | null, actions: { label: string; primary?: boolean; danger?: boolean; onClick: () => void }[], opts: { dismissable?: boolean; className?: string } = {}): ModalHandle {
  const btns = actions.map((a) => h('button', { class: `btn${a.primary ? ' primary' : ''}${a.danger ? ' danger' : ''}`, onclick: () => a.onClick() }, a.label));
  const modal = h('div', { class: `modal panel ${opts.className ?? ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, h('h2', null, title), sub ? h('p', { class: 'sub' }, sub) : null, body, btns.length ? h('div', { class: 'row' }, ...btns) : null);
  const backdrop = h('div', { class: 'modal-backdrop' }, modal);
  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey, true);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && opts.dismissable) {
      e.stopPropagation();
      close();
    }
  };
  if (opts.dismissable) backdrop.addEventListener('click', (e) => e.target === backdrop && close());
  document.addEventListener('keydown', onKey, true);
  host.appendChild(backdrop);
  requestAnimationFrame(() => (modal.querySelector('.btn.primary, .choice, .btn') as HTMLElement | null)?.focus({ preventScroll: true }));
  return { close, el: backdrop };
}

export function cardChoice(def: CardDef | null, uid: string | null, label: string | null, onPick: () => void, view?: GameView): HTMLElement {
  const el = createCardEl(uid, def, { size: 'md' });
  el.style.setProperty('--w', '150px');
  el.style.width = '150px';
  if (def && uid && view) updateOverlays(el, def, { stats: view.unitStats[uid] });
  return h('button', { class: 'choice', onclick: onPick, 'aria-label': label ?? def?.name ?? 'choice' }, el, label ? h('span', null, label) : null);
}

const CU_NAME: Record<string, string> = { G: 'Digital Splicing', B: 'Neurogenesis', R: 'Bio-Acceleration', P: 'Material Animation' };

export function paymentLabel(p: Payment): string {
  const parts = Object.entries(p.destroy).filter(([, n]) => n).map(([t, n]) => `${n} ${CU_NAME[t]}`);
  return parts.length ? `Destroy ${parts.join(' + ')}` : 'No Creation Units destroyed';
}

/** Payment picker (RULING A7-b): appears only when there is a real choice; the suggestion is preselected. */
export function pickPayment(host: HTMLElement, def: CardDef, payments: Payment[], suggested: Payment | null): Promise<Payment | null> {
  return new Promise((resolve) => {
    const key = (p: Payment) => JSON.stringify(p.destroy);
    const sug = suggested ? key(suggested) : null;
    const sorted = [...payments].sort((a, b) => (key(a) === sug ? -1 : key(b) === sug ? 1 : 0));
    const list = h(
      'div',
      { class: 'choice-grid', style: 'flex-direction:column;align-items:stretch' },
      ...sorted.map((p) =>
        h('button', { class: `btn${key(p) === sug ? ' primary' : ''}`, onclick: () => { m.close(); resolve(p); } }, paymentLabel(p), key(p) === sug ? h('span', { class: 'dim', style: 'margin-left:8px;font-weight:400' }, '(suggested: keeps your most flexible Creation Units)') : null),
      ),
    );
    const m = openModal(host, `Pay for ${def.name}`, 'The coloured cost is depleted automatically. Choose which Creation Units to destroy for the white cost.', list, [{ label: 'Cancel', onClick: () => { m.close(); resolve(null); } }], { dismissable: false });
  });
}

/** Prompt modals for decisions that interrupt resolution. */
export function promptModal(host: HTMLElement, view: GameView, legal: LegalView, answer: (choice: unknown) => void, names: (s: unknown) => string): ModalHandle | null {
  const p = legal.prompt;
  const info = (p.info ?? {}) as Record<string, any>;
  const defOfUid = (uid: string) => view.defs[view.cards[uid]?.cardId ?? ''] ?? null;
  switch (p.kind) {
    case 'oracle': {
      const def = defOfUid(info.uid);
      const body = h('div', { class: 'choice-grid' }, def ? cardChoice(def, info.uid, null, () => {}) : null);
      let m: ModalHandle;
      m = openModal(host, 'Creation Oracle', 'Keep it in hand to use in a later Creation phase (free), or use it now: search your Resource Deck for a Creation Unit and put it into your Lab.', body, [
        { label: 'Keep in hand', onClick: () => { m.close(); answer('keep'); } },
        { label: 'Use now', primary: true, onClick: () => { m.close(); answer('use'); } },
      ]);
      return m;
    }
    case 'chooseCard': {
      let m: ModalHandle;
      const byCardId = !!info.byCardId;
      const choices = (p.options ?? []).map((o) => {
        if (o === null) return null;
        const def = byCardId ? view.defs[o] ?? null : defOfUid(o);
        return cardChoice(def, byCardId ? null : o, info.reveal ? 'Reveal' : null, () => { m.close(); answer(o); }, view);
      });
      const actions = (p.options ?? []).includes(null) ? [{ label: 'Decline', onClick: () => { m.close(); answer(null); } }] : [];
      const sub = info.reveal ? 'Your opponent won the battle: choose one Power card to show them. It stays in your hand.' : info.zone === 'battleDeck' ? 'Only you can see these cards. The deck is shuffled afterwards.' : null;
      m = openModal(host, p.label, sub, h('div', { class: 'choice-grid' }, ...choices), actions);
      return m;
    }
    case 'battleOrder': {
      let m: ModalHandle;
      const choices = (p.options ?? []).map((id) => {
        const atk = view.battle?.attacks.find((a) => a.id === id);
        const def = id ? defOfUid(id) : null;
        const vs = atk?.blockers.map((u) => defOfUid(u)?.name).join(' + ');
        return cardChoice(def, id, vs ? `vs ${vs}` : null, () => { m.close(); answer(id); }, view);
      });
      m = openModal(host, 'Choose the next battle', 'Battles resolve one at a time in the order you choose; Commander auras only count while the Commander is still in play.', h('div', { class: 'choice-grid' }, ...choices), []);
      return m;
    }
    case 'decide': {
      let m: ModalHandle;
      const labels = (info.labels ?? {}) as Record<string, string>;
      const def = info.uid ? defOfUid(info.uid) : null;
      const opts = (p.options ?? []).filter((o): o is string => o !== null);
      const faces = !!info.lockOn;
      const body = h('div', { class: 'decide-box' },
        def ? h('div', { class: 'choice-grid' }, cardChoice(def, info.uid, null, () => {}, view)) : null,
        faces ? h('p', { class: 'dim' }, `Cost: ${Object.entries((info.cost ?? {}) as Record<string, unknown>).filter(([, v]) => typeof v === 'number' && v > 0).map(([k, v]) => `${k}${v}`).join(' ') || '—'}. Raw face 6 counts as numeric 4.`) : null,
      );
      const actions = [
        ...((p.options ?? []).includes(null) ? [{ label: String(info.noneLabel ?? 'No'), onClick: () => { m.close(); answer(null); } }] : []),
        ...opts.map((o, i) => ({ label: labels[o] ?? o, primary: i === 0 && !faces, onClick: () => { m.close(); answer(o); } })),
      ];
      m = openModal(host, p.label, String(info.text ?? ''), body, actions, { className: 'modal-low' });
      return m;
    }
    case 'optionalRoll': {
      const def = defOfUid(info.uid);
      let m: ModalHandle;
      m = openModal(host, def ? `${def.name}` : 'Optional roll', def?.text ?? p.label, h('div', { class: 'choice-grid' }, def ? cardChoice(def, info.uid, null, () => {}, view) : null), [
        { label: "Don't roll", onClick: () => { m.close(); answer(false); } },
        { label: 'Roll the red die', primary: true, onClick: () => { m.close(); answer(true); } },
      ]);
      return m;
    }
    case 'reroll': {
      let m: ModalHandle;
      const body = h(
        'div',
        { class: 'reroll-box' },
        h('div', { class: 'reroll-totals' },
          h('div', null, h('div', { class: 'dim' }, 'Your Physical total'), h('div', { class: 'big-num' }, String(info.yourTotal))),
          h('div', { class: 'vs' }, 'vs'),
          h('div', null, h('div', { class: 'dim' }, "Opponent's Physical total"), h('div', { class: 'big-num' }, String(info.theirTotal))),
        ),
        h('p', { class: 'dim' }, `You have a surviving re-roll icon${info.rerollsLeft > 1 ? ` (${info.rerollsLeft} left)` : ''}. The new result replaces your current Physical die (${info.yourDie}). Obliteration is checked after all re-rolls.`),
      );
      m = openModal(host, 'Re-roll your Physical die?', null, body, [
        { label: 'Keep result', onClick: () => { m.close(); answer(false); } },
        { label: 'Re-roll', primary: true, onClick: () => { m.close(); answer(true); } },
      ], { className: 'modal-low' });
      void names;
      return m;
    }
    default:
      return null;
  }
}
