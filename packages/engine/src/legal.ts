import type { Command, Payment, Seat } from '@psi-wars/shared';
import { attacksAgainst, eligibleAttackers, eligibleBlockers } from './battle';
import { discardableEquipment, movableEquipment, playOptions, unplayableReasons, validatePlay, type PlayOption } from './plays';
import { fighterUnits } from './stats';
import { card, defOf, opponentsOf, player } from './state';
import type { GameState, Prompt } from './types';
import type { PromptView } from './view';

/** LegalActions safe to send over the wire: the prompt without the engine's internal continuation. */
export type LegalView = Omit<LegalActions, 'prompt'> & {
  prompt: PromptView;
  /** Hand cards that cannot be played now, with the reason (tooltip text). */
  unplayable: Record<string, string>;
};

export function getLegalView(s: GameState, seat: Seat): LegalView | null {
  const la = getLegalActions(s, seat);
  if (!la) return null;
  const { resume: _resume, ...prompt } = la.prompt;
  return { ...la, prompt: structuredClone(prompt), unplayable: unplayableReasons(s, seat, la.prompt) };
}

export interface LegalActions {
  seat: Seat;
  prompt: Prompt;
  plays: PlayOption[];
  moveEquipment: { equip: string; to: string[] }[];
  discardEquipment: string[];
  stacks: { a: string; b: string }[];
  unstacks: string[];
  attack: { eligible: string[]; targets: Seat[] } | null;
  block: { attackers: string[]; blockers: string[] } | null;
  choices: (string | null)[] | null;
  canPass: boolean;
  canAdvance: boolean;
  canUseAbility: boolean;
  canReroll: boolean;
}

function stackOptions(s: GameState, seat: Seat): { a: string; b: string }[] {
  const lab = player(s, seat).lab.filter((u) => !card(s, u).stackPartner);
  const cyborgs = lab.filter((u) => defOf(s, u).unitType === 'Cyborg');
  const others = lab.filter((u) => defOf(s, u).unitType !== 'Cyborg');
  const out: { a: string; b: string }[] = [];
  for (const a of cyborgs) for (const b of others) out.push({ a, b });
  return out;
}

function unstackOptions(s: GameState, seat: Seat): string[] {
  return player(s, seat).lab.filter((u) => {
    const p = card(s, u).stackPartner;
    return p && defOf(s, u).unitType === 'Cyborg';
  });
}

export function getLegalActions(s: GameState, seat: Seat): LegalActions | null {
  const p = s.prompt;
  if (!p || p.seat !== seat || s.result) return null;
  const k = p.kind;
  const declaring = k === 'declareAttackers' || k === 'declareBlockers';
  const manage = k === 'main' || declaring;
  return {
    seat,
    prompt: p,
    plays: playOptions(s, seat, p),
    moveEquipment: manage ? movableEquipment(s, seat) : [],
    discardEquipment: manage ? discardableEquipment(s, seat) : [],
    stacks: declaring ? stackOptions(s, seat) : [],
    unstacks: declaring ? unstackOptions(s, seat) : [],
    attack: k === 'declareAttackers' ? { eligible: eligibleAttackers(s, seat), targets: opponentsOf(s, seat) } : null,
    block: k === 'declareBlockers' ? { attackers: attacksAgainst(s, seat).map((a) => a.id), blockers: eligibleBlockers(s, seat) } : null,
    choices: k === 'oracle' || k === 'chooseCard' || k === 'battleOrder' ? (p.options ?? []) : null,
    canPass: k === 'priority',
    canAdvance: k === 'main',
    canUseAbility: k === 'optionalRoll',
    canReroll: k === 'reroll',
  };
}

const sameFighter = (s: GameState, a: string, b: string) => a === b || card(s, a).stackPartner === b;

/** Validate a command for a seat against the current prompt. Returns an error string or null. */
export function validateCommand(s: GameState, seat: Seat, cmd: Command): string | null {
  if (cmd.type === 'Concede') return player(s, seat)?.eliminated ? 'already out' : null;
  const la = getLegalActions(s, seat);
  if (!la) return s.result ? 'game is over' : 'not your decision';
  const p = la.prompt;
  switch (cmd.type) {
    case 'PlayCard':
      return validatePlay(s, seat, p, cmd);
    case 'MoveEquipment': {
      const m = la.moveEquipment.find((x) => x.equip === cmd.equip);
      return m && m.to.includes(cmd.to) ? null : 'illegal equipment move';
    }
    case 'DiscardEquipment':
      return la.discardEquipment.includes(cmd.equip) ? null : 'cannot discard that equipment now';
    case 'Stack':
      return la.stacks.some((x) => (x.a === cmd.a && x.b === cmd.b) || (x.a === cmd.b && x.b === cmd.a)) ? null : 'illegal stack';
    case 'Unstack':
      return la.unstacks.some((u) => sameFighter(s, u, cmd.uid)) ? null : 'not a stack';
    case 'DeclareAttackers': {
      if (!la.attack) return 'not declaring attackers';
      const used = new Set<string>();
      const singleTarget = s.rules.houseRules.MP_ATTACK_TARGETING === 'singlePlayer';
      const targets = new Set<number>();
      for (const d of cmd.attacks) {
        const rep = la.attack.eligible.find((e) => sameFighter(s, e, d.uid));
        if (!rep) return `unit ${d.uid} cannot attack`;
        if (used.has(rep)) return 'a fighter was declared twice';
        used.add(rep);
        if (!la.attack.targets.includes(d.target)) return 'illegal attack target';
        targets.add(d.target);
      }
      if (singleTarget && targets.size > 1) return 'all attackers must target one player';
      return null;
    }
    case 'AssignBlockers': {
      if (!la.block) return 'not declaring blockers';
      const usedB = new Set<string>();
      const usedA = new Set<string>();
      for (const b of cmd.blocks) {
        const rep = la.block.blockers.find((e) => sameFighter(s, e, b.blocker));
        if (!rep) return `unit ${b.blocker} cannot block`;
        if (usedB.has(rep)) return 'a blocker was assigned twice';
        if (!la.block.attackers.includes(b.attacker)) return 'not an attacker you can block';
        if (usedA.has(b.attacker)) return 'only one defender per attacker (RULING A8-b)';
        usedB.add(rep);
        usedA.add(b.attacker);
      }
      return null;
    }
    case 'Pass':
      return la.canPass ? null : 'cannot pass now';
    case 'AdvancePhase':
      return la.canAdvance ? null : 'cannot advance now';
    case 'UseAbility':
      return la.canUseAbility ? null : 'no ability decision pending';
    case 'ChooseReroll':
      return la.canReroll ? null : 'no re-roll decision pending';
    case 'ChooseFromList':
      return la.choices && la.choices.includes(cmd.choice) ? null : 'not one of the choices';
  }
}

export type { Payment };
