"""
Generate card illustrations with the OpenAI Images API, using existing card art as style references.

    python tools/art/generate_art.py compare                 test cards -> art/ai-compare-v2/
    python tools/art/generate_art.py all <model> <quality>   every card in prompts_v04.json -> art/ai/<model>-<quality>/

The API key is read from ~/.psiwars-openai-key (never stored in the repo, never printed).
"""
import base64
import json
import os
import sys
import time
import urllib.error
import urllib.request

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
PROMPTS = json.load(open(os.path.join(os.path.dirname(__file__), 'prompts_v04.json'), encoding='utf8'))
KEY = open(os.path.expanduser('~/.psiwars-openai-key')).read().strip()
TEST_CARDS = ['BU_CF', 'BU_SH2', 'PW_OS']
TIERS = [('gpt-image-2.6-sunburst', 'high')]
# Style references: illustrations cropped from existing cards (art/ai-refs/).
REFS = [os.path.join(ROOT, 'art', 'ai-refs', f'{r}.png') for r in ['BU_LP', 'BU_TI', 'BU_LQ', 'TR_GSF']]


def multipart(fields, files):
    boundary = '----psiwars' + str(int(time.time() * 1000))
    parts = []
    for k, v in fields.items():
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode())
    for f in files:
        head = f'--{boundary}\r\nContent-Disposition: form-data; name="image[]"; filename="{os.path.basename(f)}"\r\nContent-Type: image/png\r\n\r\n'
        parts.append(head.encode() + open(f, 'rb').read() + b'\r\n')
    parts.append(f'--{boundary}--\r\n'.encode())
    return b''.join(parts), f'multipart/form-data; boundary={boundary}'


def generate(model: str, quality: str, card: str, out_dir: str) -> str:
    path = os.path.join(out_dir, f'{card}.png')
    if os.path.exists(path):
        return path
    prompt = f"{PROMPTS['style']}\n\nSubject: {PROMPTS['cards'][card]}"
    body, ctype = multipart({'model': model, 'prompt': prompt, 'size': '1024x1536', 'quality': quality, 'n': '1'}, REFS)
    for attempt in range(3):
        req = urllib.request.Request('https://api.openai.com/v1/images/edits', data=body,
                                     headers={'Authorization': f'Bearer {KEY}', 'Content-Type': ctype})
        try:
            data = json.load(urllib.request.urlopen(req, timeout=400))
            item = data['data'][0]
            raw = base64.b64decode(item['b64_json']) if item.get('b64_json') else urllib.request.urlopen(item['url'], timeout=120).read()
            os.makedirs(out_dir, exist_ok=True)
            open(path, 'wb').write(raw)
            return path
        except urllib.error.HTTPError as e:
            print(f'  {card} {model}: HTTP {e.code} {e.read().decode(errors="replace")[:300]}', flush=True)
            if e.code in (400, 401, 403, 404):
                return ''
            time.sleep(5 * (attempt + 1))
        except Exception as e:
            print(f'  {card} {model}: {e}', flush=True)
            time.sleep(5 * (attempt + 1))
    return ''


if __name__ == '__main__':
    mode = sys.argv[1] if len(sys.argv) > 1 else 'compare'
    if mode == 'compare':
        for model, quality in TIERS:
            out = os.path.join(ROOT, 'art', 'ai-compare-v2', f'{model}-{quality}')
            for card in TEST_CARDS:
                t = time.time()
                p = generate(model, quality, card, out)
                print(f'{model} {quality} {card}: {"ok" if p else "FAILED"} ({time.time() - t:.0f}s)', flush=True)
    else:
        model, quality = sys.argv[2], sys.argv[3]
        out = os.path.join(ROOT, 'art', 'ai', f'{model}-{quality}')
        cards = sys.argv[4].split(',') if len(sys.argv) > 4 else list(PROMPTS['cards'])
        for i, card in enumerate(cards, 1):
            t = time.time()
            p = generate(model, quality, card, out)
            print(f'[{i}/{len(cards)}] {card}: {"ok" if p else "FAILED"} ({time.time() - t:.0f}s)', flush=True)
