"""
Install generated illustrations as card art.

    python tools/art/install_art.py BU_ML,BU_AA,BU_HR [source_dir]

For each card: crop the image to the card ratio (788:1088), save it as art/masters/cards/<ID>.jpg,
point data/cards.json at it (art = cards/<ID>, artSource = the generator), and record it in
tools/art/installed.json so the client knows it is a full illustration (no printed frame).
Then run `npm run assets:build` to produce the sized variants and manifest entries.
"""
import json
import os
import sys

from PIL import Image

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
SRC = sys.argv[2] if len(sys.argv) > 2 else os.path.join(ROOT, 'art', 'ai', 'gpt-image-2.6-sunburst-high')
ids = sys.argv[1].split(',')
cards_path = os.path.join(ROOT, 'data', 'cards.json')
data = json.load(open(cards_path, encoding='utf8'))
by_id = {c['id']: c for c in data['cards']}
installed_path = os.path.join(os.path.dirname(__file__), 'installed.json')
installed = json.load(open(installed_path, encoding='utf8')) if os.path.exists(installed_path) else {}

for cid in ids:
    im = Image.open(os.path.join(SRC, f'{cid}.png')).convert('RGB')
    w, h = im.size
    target_h = round(w * 1088 / 788)
    top = max(0, (h - target_h) // 2)
    im = im.crop((0, top, w, top + min(h, target_h)))
    out = os.path.join(ROOT, 'art', 'masters', 'cards', f'{cid}.jpg')
    os.makedirs(os.path.dirname(out), exist_ok=True)
    im.save(out, quality=94)
    by_id[cid]['art'] = f'cards/{cid}'
    by_id[cid]['artSource'] = 'ai: gpt-image-2.6-sunburst (tools/art)'
    installed[cid] = {'source': os.path.relpath(os.path.join(SRC, f'{cid}.png'), ROOT).replace('\\', '/'), 'fullIllustration': True}
    print('installed', cid, im.size)

json.dump(data, open(cards_path, 'w', encoding='utf8'), indent=1, ensure_ascii=False)
json.dump(installed, open(installed_path, 'w', encoding='utf8'), indent=1)
