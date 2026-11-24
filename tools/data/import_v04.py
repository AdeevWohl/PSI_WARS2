"""
Import the v0.4 card set workbook into data/cards.json and data/decks/*.json.

    python tools/data/import_v04.py "<path to Psi Wars - Card Set v0.4.xlsx>"

The workbook supplies names, costs, strengths, Equipment values, timing, relocation costs and
rules text. Executable abilities are NOT read from the workbook: each card's engine effects are
defined in EFFECTS below (by v0.4 card name) and implemented in packages/engine/src/v04.ts.
Existing card IDs and artwork are preserved; new cards get stable generated IDs (kept in
data/v04_ids.json so re-imports never renumber them).
"""
import json
import os
import re
import sys

import openpyxl

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
CARDS = os.path.join(ROOT, 'data', 'cards.json')
IDS = os.path.join(ROOT, 'data', 'v04_ids.json')
DECKS = os.path.join(ROOT, 'data', 'decks')

E = lambda trigger, effect, **params: {'trigger': trigger, 'effect': effect, 'params': params}
CR = ['Creature', 'Cyborg']
RC = ['Robot', 'Cyborg']

EFFECTS = {
    'Vesper Ripper': [E('ModifyRoll', 'ModifyRollTable', die='red', stat='physical', optional=True, bySide={'1': -1, '2': 2, '3': -1, '4': 2, '5': -1, '6': 2})],
    'Jingwa Psi Avenger': [E('OnBlocked', 'BlockedTax')],
    'Marrow Parasite': [E('AfterEngagement', 'MarrowMutation')],
    'Shadow Assassin': [E('RollX', 'RollX', die='red', stat='psionic', rider='lowPhysical')],
    'Siana Commander': [E('EndOfBattle', 'SianaMutation')],
    'Trangarey Scythe': [E('AttackDeclared', 'WidthBonus', others=2)],
    'Acorbeac Destroyer': [E('Static', 'StatBonus', stat='cyber', bonus=1, when={'stackedWith': 'Robot'}), E('Static', 'StatBonus', stat='psionic', bonus=1, when={'stackedWith': 'Creature'})],
    'Veydran Executioner': [E('OnDestroyEnemyUnit', 'DamageLab', amount=1)],
    'Javarow Protector': [E('Static', 'StackShield')],
    'Kyler Revenant': [E('AfterEngagement', 'DrawOnKill')],
    'Lodner Predator': [E('AfterEngagement', 'DepleteOpponentCU')],
    'Third I': [E('OnStack', 'StackChoice', partnerType='Creature', opts=['psionic', 'physical'])],
    'Zomber Mercenary': [E('RollX', 'RollX', die='red', stat='psionic', robotSetX3=True)],
    'Davileam Commander': [E('Protocol', 'ProtocolBoost', mode='Assault', when='attack'), E('Protocol', 'ProtocolBoost', mode='Guard', when='defend'), E('Protocol', 'ProtocolPrecision', mode='Precision')],
    'Hydra Bot': [E('Static', 'StatBonus', stat='cyber', bonus=1, when={'equipped': True})],
    'Loquidor Stalker': [E('Activated', 'Intercept', cost={'P': 1})],
    'Nomis Analyzer': [E('OnCreate', 'LookAtHand'), E('Activated', 'NomisBoost', cost={'G': 1})],
    'Therabot Seeker': [E('Static', 'LockOn', cost={'G': 1})],
    'Psi Bolster': [E('BeforeDice', 'BolsterSwap')],
    'Vegian Cyber Shield': [E('Static', 'IgnoreObliterate')],
    'Bio Pulse': [E('OnPlay', 'DamageTargets', amount=1, max=2, filter={'unitType': CR})],
    'Creature Regenerate': [E('OnPlay', 'ReviveToLab', filter={'cardType': 'BattleUnit', 'unitType': CR, 'maxCost': 3, 'psionicPositive': True}, reanimate={'physical': 2, 'psionic': -2})],
    'Equipment Hunter': [E('OnPlay', 'TutorToHand', filter={'cardType': 'Equipment'})],
    'Equipment Mechanic': [E('OnPlay', 'EquipmentMechanic')],
    'High-Energy Pulse': [E('OnPlay', 'DisableTargets', max=2, hasAbility='cyber')],
    'Overload Strike': [E('OnPlay', 'DealDamage', amount=3, labAmount=2)],
    'Robo Refurb': [E('OnPlay', 'ReviveToLab', filter={'cardType': 'BattleUnit', 'unitType': 'Robot', 'maxCost': 3})],
    'Static Burst': [E('OnPlay', 'DamageTargets', amount=1, max=2, filter={'unitType': RC})],
    'Grankor Stasis Field': [E('OnPlay', 'TrapUnit', target='opposingUnit', release='escape'), E('TrapEscapeCheck', 'PhysicalPlusRoll', die='red', threshold=5, atLeast=True, maxFails=2)],
    'Fengar Berserker': [E('RollX', 'RollX', die='red', stat='psionic', rider='face6Physical')],
    'Garilian Seer': [E('RollX', 'RollX', die='red', stat='psionic', rider='seer')],
    'Warend Reaper': [E('OnCreate', 'CannibalizeOnCreate')],
    'Bellarn Cyborg': [E('BeforeDice', 'SelfShift', **{'from': 'cyber', 'to': 'physical'})],
    'Urilian Overlord': [E('RollX', 'RollX', die='red', stat='cyber', robotReroll=True)],
    'Veeda Commander': [E('OnStack', 'VeedaStack')],
    'Pencar Inferno': [E('BeforeDice', 'PayBoost', cost={'P': 1})],
    'Stealth Skyfire': [E('Static', 'StealthBlock')],
    'Tricapia Guardian': [E('Static', 'CalibrateSelf', die='physical', whenDefending=True)],
    'Xardy Piercer': [E('Static', 'StatBonus', stat='physical', bonus=1, when={'equipped': True, 'inBlockedBattle': True})],
    'Mental Disrupter': [E('OnPlay', 'DisableTargets', max=2, hasAbility='psionic')],
    'Signal Mite': [E('OnCreate', 'ReorderTop', n=2)],
    'Assembly Wisp': [E('OnCreate', 'WispRelocate')],
    'Targeting Node': [E('Activated', 'TargetingNode', cost={'G': 1})],
    'Spore Larva': [E('OnDestroyed', 'LarvaBurst')],
    'Mind Leech': [E('OnBlocked', 'LeechShift')],
    'Brood Carrier': [E('OnCreate', 'ReorderTop', n=2, revealCreature=True)],
    'Relay Chimera': [E('Static', 'StatBonus', stat='psionic', bonus=1, when={'stackedWith': 'Creature'}), E('Static', 'StatBonus', stat='cyber', bonus=1, when={'stackedWith': 'Robot'})],
    'Fabricator Drone': [E('Activated', 'FabricatorDiscount')],
    'Scrap Harvester': [E('Activated', 'HarvestScrap')],
    'Vector Sentinel': [E('Static', 'CalibrateSelf', die='physical', whenDefending=True)],
    'Countermeasure Array': [E('Static', 'LockOn', cost={'G': 1})],
    'Railgun Overseer': [E('OnCreate', 'LinkRobot'), E('Static', 'StatBonus', stat='physical', bonus=1, when={'linkEquipped': True})],
    'Foundry Titan': [E('OnCreate', 'TitanRecall')],
    'Grid Marshal': [E('Protocol', 'ProtocolLockOn', mode='Scan', cost={'G': 1}), E('Protocol', 'ProtocolCalibrate', mode='Guard', die='physical', whenDefending=True)],
    'Swarm Caller': [E('OnCreate', 'SwarmCall')],
    'Carrion Sprinter': [E('Static', 'SprinterHunger')],
    'Morphic Adept': [E('BeforeDice', 'MorphicShift')],
    'Chitin Weaver': [E('AfterEngagement', 'MutateOnPsiLoss')],
    'Hive Regent': [E('AttackDeclared', 'SwarmBoost', min=3)],
    'Apex Aberration': [E('RollX', 'RollX', die='red', stat='psionic', rider='apex')],
    'Suture Architect': [E('Activated', 'SutureRelocate')],
    'Neural Interface': [E('Static', 'PartnerReroll')],
    'Alloy Symbiont': [E('AfterEngagement', 'AlloyUpgrade')],
    'Convergence Engine': [E('OnStack', 'Convergence')],
    'Emergency Firewall': [E('OnPlay', 'CounterPulse')],
    'Salvage Protocol': [E('OnPlay', 'SalvageProtocol')],
    'Modular Assembly': [E('OnPlay', 'ModularAssembly', maxCost=2)],
    'Repair Circuit': [E('OnPlay', 'PreventDamage', amount=1, filter={'unitType': RC})],
    'Signal Jam': [E('OnPlay', 'SignalJam')],
    'Molting': [E('OnPlay', 'Molting', amount=2)],
    'Forced Evolution': [E('OnPlay', 'PowerRoll', bands=[{'values': [1, 3, 5], 'stat': 'psionic', 'amount': 2}, {'values': [2, 4], 'stat': 'physical', 'amount': 1}])],
    'Cannibalistic Instinct': [E('OnPlay', 'CannibalInstinct')],
    'Brood Recall': [E('OnPlay', 'ReturnUpTo', n=2, filter={'unitType': 'Creature', 'exactCost': 1})],
    'Unstable Carapace': [E('OnPlay', 'PowerRoll', requireBlocked=True, bands=[{'values': [1, 2], 'stat': 'physical', 'amount': 1}, {'values': [3, 4, 5], 'stat': 'psionic', 'amount': 1}])],
    'Crosslink': [E('OnPlay', 'StackBuff', cyber=1, psionic=1)],
    'Emergency Separation': [E('OnPlay', 'SplitStack')],
    'Interference Net': [E('OnPlay', 'TrapUnit', target='opposingUnit', release='nextCleanup', filter={'maxPrintedPhysical': 2})],
    'Parasitic Snare': [E('OnPlay', 'DepleteUnit', physical=-1)],
    'Adaptive Membrane': [E('Static', 'ReturnOnDestroy')],
    'Interface Plating': [E('Static', 'PartnerShield')],
    'Carrion Foundress': [E('AfterEngagement', 'Feeding')],
}
VANILLA = {'Rupture Brute', 'Psi Hatchling', 'Scout Drone', 'Scrap Hulk', 'Patchwork Initiate', 'Cyber Onslaught', 'Kranthard Armour',
           'Mental Shield', 'Physical Augmentation', 'Servo Harness', 'Bio-Acceleration', 'Digital Splicing', 'Material Animation', 'Neurogenesis'}
KEEP_OLD_EFFECTS = {'Creation Oracle', 'Resource Fortification'}

# Rules changes made after the workbook (v0.4.1): text overrides by card name.
TEXT_OVERRIDES = {
    'Parasitic Snare': 'Choose a Battle Unit under enemy control. Deplete it. It loses 1 Physical until the end of the turn.',
}

PROTOCOLS = {
    'Davileam Commander': {
        'Assault': 'choose up to two attacking Robots under your control at declaration; each gains +1 Physical for this Battle phase.',
        'Guard': 'choose up to two defending Robots under your control at declaration; each gains +1 Physical for this Battle phase.',
        'Precision': 'one Robot under your control may Calibrate its Physical die each Battle phase.',
    },
    'Grid Marshal': {
        'Scan': 'this gains Lock-On (deplete G1).',
        'Guard': 'when this defends, it may Calibrate its Physical die.',
    },
}

KEYWORD_OF = {
    'LockOn': 'Lock-On', 'ProtocolLockOn': 'Lock-On', 'CalibrateSelf': 'Calibrate', 'ProtocolCalibrate': 'Calibrate', 'ProtocolPrecision': 'Calibrate',
    'TargetingNode': 'Calibrate', 'MarrowMutation': 'Mutation', 'SianaMutation': 'Mutation', 'MutateOnPsiLoss': 'Mutation',
    'CannibalizeOnCreate': 'Cannibalize', 'CannibalInstinct': 'Cannibalize', 'TrapUnit': 'Containment', 'Feeding': 'Feeding', 'DepleteUnit': 'Deplete',
}

TYPE = {'Battle Unit': 'BattleUnit', 'Creation Unit': 'CreationUnit', 'Equipment': 'Equipment', 'Power': 'Power', 'Resource': 'Resource'}
PREFIX = {'BattleUnit': 'BU', 'Equipment': 'EQ', 'Power': 'PW', 'Resource': 'RS', 'CreationUnit': 'CU'}


def num(v):
    if v in (None, ''):
        return 0
    if isinstance(v, (int, float)):
        return int(v)
    return int(str(v).strip() or 0)


def stat(v):
    if v in (None, ''):
        return 0
    if str(v).strip().upper() == 'X':
        return 'X'
    return int(v)


def pools(text):
    """'R/P; R/P' -> [['R','P'], ['R','P']]"""
    if not text:
        return []
    return [[x.strip() for x in part.split('/') if x.strip()] for part in str(text).split(';') if part.strip()]


def parse_move(text):
    if not text or str(text).strip().lower() == 'free':
        return None
    m = re.match(r'\s*Deplete\s+([GBRP/]+)\s*(\d+)', str(text))
    if not m:
        raise ValueError(f'unreadable move cost {text!r}')
    types, n = m.group(1), int(m.group(2))
    c = {'G': 0, 'B': 0, 'R': 0, 'P': 0, 'W': 0}
    if '/' in types:
        c['choice'] = [types.split('/')] * n
    else:
        c[types] += n
    return c


def main(path):
    wb = openpyxl.load_workbook(path, data_only=False)
    ws = wb['Cards']
    head = [c.value for c in ws[1]]
    rows = [dict(zip(head, r)) for r in ws.iter_rows(min_row=2, values_only=True) if r[1]]
    old = {c['id']: c for c in json.load(open(CARDS, encoding='utf8'))['cards']}
    ids = json.load(open(IDS, encoding='utf8')) if os.path.exists(IDS) else {}
    used = set(old) | set(ids.values())
    out = []
    for r in rows:
        name = r['Card Name'].strip()
        ctype = TYPE[r['Card Type'].strip()]
        cid = (r['ID (original)'] or '').strip() if r['ID (original)'] not in (None, '-') else ''
        if not cid:
            cid = ids.get(name)
        if not cid:
            base = PREFIX[ctype] + '_' + ''.join(w[0] for w in re.findall(r'[A-Za-z]+', name)).upper()[:3]
            cid, k = base, 2
            while cid in used:
                cid, k = f'{base}{k}', k + 1
            ids[name] = cid
        used.add(cid)
        prev = old.get(cid, {})
        d = {'id': cid, 'name': name, 'deck': (r['Deck'] or 'Battle').strip().lower(), 'cardType': ctype}
        if r['Unit Type']:
            d['unitType'] = r['Unit Type'].strip()
        if ctype == 'BattleUnit':
            d['isCommander'] = r['Commander'] == 'Y'
        if ctype == 'CreationUnit':
            d['cuType'] = prev.get('cuType')
        if ctype not in ('CreationUnit', 'Resource'):
            cost = {k: num(r[k]) for k in 'GBRPW'}
            if num(r['A']):
                cost['A'] = num(r['A'])
            ch = pools(r['Pay One Of'])
            if ch:
                cost['choice'] = ch
            bp = (r['Burn pool (W)'] or '').strip()
            if bp:
                cost['burnPool'] = ['G', 'B', 'R', 'P'] if bp.lower() == 'any' else [x.strip() for x in bp.split('/')]
            d['cost'] = cost
        if ctype in ('BattleUnit', 'Equipment'):
            d['stats'] = {'cyber': stat(r['Cyber']), 'psionic': stat(r['Psionic']), 'physical': stat(r['Physical'])}
        if ctype == 'Equipment':
            d['equip'] = {'ability': r['Equipment Boost'].strip().lower(), 'bonus': num(r['Bonus']), 'allowed': [x.strip() for x in str(r['Fits']).split(',')]}
            mc = parse_move(r['Move cost (Creation)'])
            if mc:
                d['equip']['moveCost'] = mc
        if ctype == 'Power':
            d['timing'] = (r['Power timing'] or 'Pulse').strip()
        if name in PROTOCOLS:
            d['protocols'] = PROTOCOLS[name]
        if name in KEEP_OLD_EFFECTS:
            d['effects'] = prev.get('effects', [])
        elif name in EFFECTS:
            d['effects'] = EFFECTS[name]
        elif name in VANILLA:
            d['effects'] = []
        else:
            raise SystemExit(f'no engine effects defined for {name}')
        text = r['Proposed Rules Text']
        d['text'] = TEXT_OVERRIDES.get(name, '' if text in (None, 'None') else str(text))
        kws = sorted({KEYWORD_OF[e['effect']] for e in d['effects'] if e['effect'] in KEYWORD_OF} | ({'Protocol'} if name in PROTOCOLS else set()) | ({d['timing']} if ctype == 'Power' else set()) | ({'Relocate'} if ctype == 'Equipment' and 'moveCost' in d.get('equip', {}) else set()) | ({'Reanimated'} if name == 'Creature Regenerate' else set()))
        if kws:
            d['keywords'] = kws
        d['implementation'] = 'v0.4: ' + ('; '.join(f"{e['trigger']} → {e['effect']}" for e in d['effects']) or 'no ability')
        for k in ('art', 'artSource', 'printed'):
            if k in prev:
                d[k] = prev[k]
        d['enabled'] = r['Enabled'] == 'Y'
        d['origin'] = 'v0.4' if cid not in old else prev.get('origin', 'v0.3')
        if r.get('Archetype / Role'):
            d['role'] = str(r['Archetype / Role'])
        if r.get('Design / Balance Note'):
            d['designNote'] = str(r['Design / Balance Note'])
        out.append(d)
    json.dump({'schemaVersion': 2, 'source': 'Psi Wars - Card Set v0.4.xlsx (imported by tools/data/import_v04.py)', 'cards': out}, open(CARDS, 'w', encoding='utf8'), indent=1, ensure_ascii=False)
    json.dump(ids, open(IDS, 'w', encoding='utf8'), indent=1, ensure_ascii=False)
    byname = {c['name']: c['id'] for c in out}

    dl = wb['Deck Lists']
    decks = {}
    for r in dl.iter_rows(min_row=2, values_only=True):
        if not r[0]:
            continue
        deck, section, cname, copies = r[0], r[1], r[2], int(r[3])
        dd = decks.setdefault(deck, {'battle': {}, 'resource': {}})
        dd['battle' if section == 'Battle' else 'resource'][byname[cname]] = copies
    for deck, lists in decks.items():
        slug = 'v04-' + deck.lower().replace(' ', '-')
        json.dump({'id': slug, 'name': deck, 'starter': True, 'source': 'Card Set v0.4 example deck', **lists}, open(os.path.join(DECKS, slug + '.json'), 'w', encoding='utf8'), indent=1)
    print(len(out), 'cards;', len(ids), 'new ids;', len(decks), 'decks')


if __name__ == '__main__':
    main(sys.argv[1])
