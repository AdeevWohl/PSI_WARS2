import type { CUType, Payment, Seat } from '@psi-wars/shared';
import { paymentFromTypes, type CardDef, type Cost, type GameView, type LegalView } from '@psi-wars/engine';
import { costPips, pipEl } from '../render/card';
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

/**
 * Creation Unit picker (v0.4.1): click the exact Creation Units to deplete or burn. Each click cycles a
 * unit: unused → deplete → burn (when the cost burns) → unused. The engine's suggestion is preselected;
 * "Pay" works only when the chosen units pay the cost exactly. Fortified units (◈) are depleted instead
 * of destroyed when burned, and their Fortification is used up — so whether to use it is your choice.
 */
export function pickPayment(host: HTMLElement, view: GameView, seat: Seat, def: CardDef, cost: Cost, suggested: Payment | null): Promise<Payment | null> {
  return new Promise((resolve) => {
    const ready = (view.players[seat]?.cus ?? []).filter((u) => view.cards[u] && !view.cards[u]!.depleted);
    const typeOf = (u: string) => view.defs[view.cards[u]!.cardId]!.cuType as CUType;
    const fortified = (u: string) => {
      const eq = view.cards[u]!.equipment;
      return !!eq && !!view.cards[eq] && view.defs[view.cards[eq]!.cardId]!.effects.some((e) => e.effect === 'FortifyResource');
    };
    const burns = cost.W + (cost.burns?.length ?? 0) > 0;
    const state = new Map<string, '' | 'deplete' | 'burn'>(ready.map((u) => [u, '']));
    // Preselect the suggestion: depletions from unfortified units, burns from fortified ones first.
    if (suggested) {
      const want = (types: CUType[], mode: 'deplete' | 'burn') => {
        for (const t of types) {
          const pool = ready.filter((u) => typeOf(u) === t && state.get(u) === '').sort((a, b) => (mode === 'burn' ? Number(fortified(b)) - Number(fortified(a)) : Number(fortified(a)) - Number(fortified(b))));
          if (pool[0]) state.set(pool[0], mode);
        }
      };
      const fixed: CUType[] = [];
      for (const t of ['G', 'B', 'R', 'P'] as CUType[]) for (let k = 0; k < cost[t]; k++) fixed.push(t);
      for (const [t, n] of Object.entries(suggested.any ?? {})) for (let k = 0; k < (n ?? 0); k++) fixed.push(t as CUType);
      want([...fixed, ...(suggested.choice ?? [])], 'deplete');
      const b: CUType[] = [];
      for (const [t, n] of Object.entries(suggested.destroy)) for (let k = 0; k < (n ?? 0); k++) b.push(t as CUType);
      want([...b, ...(suggested.burns ?? [])], 'burn');
    }
    const status = h('div', { class: 'pay-status' });
    const grid = h('div', { class: 'pay-grid' });
    const payBtn = h('button', { class: 'btn primary' }, 'Pay') as HTMLButtonElement;
    const current = (): Payment | null => {
      const dep = ready.filter((u) => state.get(u) === 'deplete');
      const brn = ready.filter((u) => state.get(u) === 'burn');
      const p = paymentFromTypes(cost, dep.map(typeOf), brn.map(typeOf));
      return p ? { ...p, pick: { deplete: dep, burn: brn } } : null;
    };
    const draw = () => {
      grid.replaceChildren(...ready.map((u) => {
        const st = state.get(u)!;
        return h('button', {
          class: `pay-cu cu-${typeOf(u)} ${st}`, title: `${view.defs[view.cards[u]!.cardId]!.name}${fortified(u) ? ' (Resource Fortification: depleted instead of destroyed if burned)' : ''}`,
          onclick: () => {
            const next = st === '' ? 'deplete' : st === 'deplete' && burns ? 'burn' : '';
            state.set(u, next);
            draw();
          },
        }, h('span', { class: 'pay-dot' }), fortified(u) ? h('span', { class: 'pay-fort' }, '◈') : null, h('span', { class: 'pay-mode' }, st === 'deplete' ? 'Deplete' : st === 'burn' ? 'Burn' : '—'));
      }));
      const p = current();
      payBtn.disabled = !p;
      status.textContent = p ? 'These Creation Units pay the cost exactly.' : 'Choose Creation Units until they pay the cost exactly (each unit pays one light).';
      status.classList.toggle('ok', !!p);
    };
    payBtn.onclick = () => {
      const p = current();
      if (!p) return;
      m.close();
      resolve(p);
    };
    const body = h('div', { class: 'pay-box' }, h('div', { class: 'pay-cost' }, h('span', { class: 'dim' }, 'Cost'), h('div', { class: 'lf-pips row big' }, costPips(cost).map(pipEl))), grid, status);
    const m = openModal(host, `Pay for ${def.name}`, 'Click a Creation Unit to deplete it; click again to burn it (if the cost burns). Silver = deplete, black = burn.', body, [{ label: 'Cancel', onClick: () => { m.close(); resolve(null); } }], { dismissable: false });
    m.el.querySelector('.row')?.appendChild(payBtn);
    draw();
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
