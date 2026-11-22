import type { GameState } from '../src/index';
import { viewFor } from '../src/index';

const ARRAY_ZONES = ['battleDeck', 'resourceDeck', 'hand', 'lab', 'cus', 'trapped', 'discard'] as const;

/** Structural invariants that must hold after every command. Returns a list of violations. */
export function checkInvariants(s: GameState): string[] {
  const errs: string[] = [];
  const seen = new Map<string, string>();
  for (const p of s.players) {
    for (const z of ARRAY_ZONES) {
      for (const uid of p[z]) {
        if (seen.has(uid)) errs.push(`${uid} in two zones (${seen.get(uid)} and ${p.seat}.${z})`);
        seen.set(uid, `${p.seat}.${z}`);
        const c = s.cards[uid];
        if (!c) errs.push(`${uid} missing instance`);
        else if (c.zone !== z || c.owner !== p.seat) errs.push(`${uid} zone ${c.owner}.${c.zone} but listed in ${p.seat}.${z}`);
      }
    }
  }
  for (const c of Object.values(s.cards)) {
    if ((ARRAY_ZONES as readonly string[]).includes(c.zone) && !seen.has(c.uid)) errs.push(`${c.uid} zone ${c.zone} but in no array`);
    if (c.zone === 'attached') {
      const host = c.attachedTo ? s.cards[c.attachedTo] : undefined;
      if (!host) errs.push(`${c.uid} attached to nothing (Equipment/Trap can never be on its own)`);
      else if (host.zone !== 'lab' && host.zone !== 'trapped') errs.push(`${c.uid} attached to ${host.uid} in ${host.zone}`);
      else if (host.equipment !== c.uid && host.trappedBy !== c.uid) errs.push(`${c.uid} attached to ${host.uid} without back-reference`);
    }
    if (c.equipment) {
      const e = s.cards[c.equipment];
      if (!e || e.zone !== 'attached' || e.attachedTo !== c.uid) errs.push(`${c.uid} equipment ${c.equipment} inconsistent`);
      if (c.zone !== 'lab' && c.zone !== 'trapped') errs.push(`${c.uid} out of play but holds equipment`);
    }
    if (c.trappedBy && c.zone !== 'trapped') errs.push(`${c.uid} trappedBy set but zone ${c.zone}`);
    if (c.zone === 'trapped' && !c.trappedBy) errs.push(`${c.uid} trapped with no trap card`);
    if (c.stackPartner) {
      const p = s.cards[c.stackPartner];
      if (!p || p.stackPartner !== c.uid) errs.push(`${c.uid} asymmetric stack`);
      if (c.zone !== 'lab') errs.push(`${c.uid} stacked outside the Lab`);
    }
    if (c.zone === 'stack' && !s.stack.some((x) => x.uid === c.uid)) errs.push(`${c.uid} in stack zone but not on the stack`);
  }
  for (const x of s.stack) if (s.cards[x.uid]?.zone !== 'stack') errs.push(`stack item ${x.uid} not in stack zone`);
  if (!s.prompt && !s.result) errs.push('no prompt and no result (soft-lock)');
  if (s.prompt && s.players[s.prompt.seat]?.eliminated) errs.push('prompt owned by an eliminated player');
  return errs;
}

/** No seat's view may contain another seat's hand or any deck card (except its own prompt choices). */
export function checkViews(s: GameState): string[] {
  const errs: string[] = [];
  for (const p of s.players) {
    const v = viewFor(s, p.seat);
    const allowed = new Set((s.prompt?.seat === p.seat ? s.prompt.options : []) ?? []);
    for (const c of Object.values(v.cards)) {
      if (c.zone === 'hand' && c.owner !== p.seat) errs.push(`seat ${p.seat} sees opponent hand card ${c.uid}`);
      if ((c.zone === 'battleDeck' || c.zone === 'resourceDeck') && !allowed.has(c.uid)) errs.push(`seat ${p.seat} sees deck card ${c.uid}`);
    }
    for (const o of v.players) if (o.seat !== p.seat && o.hand !== null) errs.push(`seat ${p.seat} sees hand of ${o.seat}`);
    const tokens = new Set(JSON.stringify({ ...v, defs: null }).match(/"c\d+"/g) ?? []);
    for (const o of s.players) {
      if (o.seat === p.seat) continue;
      for (const uid of [...o.hand, ...o.battleDeck, ...o.resourceDeck]) {
        if (!allowed.has(uid) && tokens.has(`"${uid}"`)) {
          errs.push(`seat ${p.seat} view contains hidden uid ${uid}`);
          break;
        }
      }
    }
  }
  return errs;
}
