"""Psi Wars art pipeline, step 1: extract card masters from the artist's PSD files.

Usage (from the repo root):
    pip install psd-tools pillow
    python tools/assets/extract_psd.py --psd-dir "../Final Cards Single Number Full Art" --loose-dir ".."

Why Python: only psd-tools reads these files correctly. Several PSDs carry a 5th
(alpha) channel in the merged composite, which Pillow and the Node PSD readers
misinterpret as garbage. psd-tools reads the merged composite (no layer
re-rendering) and converts CMYK -> sRGB through the embedded ICC profile.

Mapping comes from data/cards.json (`artSource` per card) — never from file
names, several of which are misspelled or name the wrong card.

Outputs (originals are never modified):
    art/masters/cards/<CARD_ID>.jpg   full-resolution sRGB master (1576x2176)
    art/masters/ui/logo.jpg           hexagon logo
    art/masters/ui/splash.jpg         menu background (stand-in, see ART_MAPPING.md)
    art/masters/extract-report.json   what was mapped, unmapped, missing
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

from PIL import Image

Image.MAX_IMAGE_PIXELS = None

REPO = Path(__file__).resolve().parents[2]
CARD_RATIO = 788 / 1088

# Non-card UI art found among the supplied files (see ART_MAPPING.md).
UI_FILES = {
    "logo.jpg": "Psi wars 3.jpg",  # 410x410 hexagon logo (square crop)
    "logo-wide.jpg": "Psi wars.jfif",  # 695x431 logo on hex background
    # Unframed Creation Oracle illustration — the same picture as the spec's
    # Creation_Oracle splash art, but only 680x907. Stand-in until the 4500x6000 file arrives.
    "splash.jpg": "1ac01666c2385635e695d7216fdefa1a_original.jpg",
}


def load_composite(path: Path) -> Image.Image:
    from psd_tools import PSDImage  # imported lazily so --help works without it

    psd = PSDImage.open(path)
    im = psd.topil(apply_icc=True)
    if im is None:
        raise RuntimeError("PSD has no merged composite (saved without 'Maximize Compatibility')")
    if im.mode in ("RGBA", "LA"):
        bg = Image.new("RGB", im.size, (0, 0, 0))
        bg.paste(im, mask=im.split()[-1])
        im = bg
    return im.convert("RGB")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--psd-dir", required=True, type=Path)
    ap.add_argument("--loose-dir", type=Path, help="folder holding the loose logo / illustration JPGs")
    ap.add_argument("--out", type=Path, default=REPO / "art" / "masters")
    ap.add_argument("--only", nargs="*", help="limit to these card IDs")
    ap.add_argument("--quality", type=int, default=92)
    args = ap.parse_args()

    cards = json.loads((REPO / "data" / "cards.json").read_text(encoding="utf-8"))["cards"]
    out_cards = args.out / "cards"
    out_ui = args.out / "ui"
    out_cards.mkdir(parents=True, exist_ok=True)
    out_ui.mkdir(parents=True, exist_ok=True)

    psd_files = {p.name: p for p in args.psd_dir.glob("*.psd")}
    used: set[str] = set()
    report: dict = {"mapped": [], "missing": [], "unmapped": [], "ratioMismatch": [], "ui": []}

    for card in cards:
        src = card.get("artSource")
        if not src:
            report["missing"].append({"id": card["id"], "name": card["name"], "reason": "no artSource in cards.json"})
            continue
        if args.only and card["id"] not in args.only:
            used.add(src)
            continue
        path = psd_files.get(src)
        if path is None:
            report["missing"].append({"id": card["id"], "name": card["name"], "reason": f"file not found: {src}"})
            continue
        used.add(src)
        im = load_composite(path)
        ratio = im.width / im.height
        if abs(ratio - CARD_RATIO) > 0.005:
            report["ratioMismatch"].append({"id": card["id"], "size": im.size})
        dest = out_cards / f"{card['id']}.jpg"
        im.save(dest, quality=args.quality, subsampling=0, optimize=True)
        report["mapped"].append({"id": card["id"], "name": card["name"], "file": src, "size": list(im.size)})
        print(f"  {card['id']:<7} <- {src}  {im.size[0]}x{im.size[1]}", flush=True)

    report["unmapped"] = sorted(set(psd_files) - used)

    if args.loose_dir:
        for dest_name, src_name in UI_FILES.items():
            src = args.loose_dir / src_name
            if src.exists():
                Image.open(src).convert("RGB").save(out_ui / dest_name, quality=95)
                report["ui"].append({"asset": dest_name, "file": src_name})
            else:
                report["missing"].append({"id": f"ui/{dest_name}", "name": dest_name, "reason": f"file not found: {src_name}"})

    (args.out / "extract-report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"mapped {len(report['mapped'])}, missing {len(report['missing'])}, unmapped PSDs {len(report['unmapped'])}")
    for m in report["missing"]:
        print("  MISSING", m)
    for u in report["unmapped"]:
        print("  UNMAPPED", u)
    return 0


if __name__ == "__main__":
    sys.exit(main())
