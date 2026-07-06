"""Regenerate emplacements.txt + meta.json from the SAP BI export.

Reads the emplacement_depot.xlsx export dropped on the WMS network share and
converts it to the compact pipe-delimited format the 3D map fetches at
runtime. Run this whenever the source file changes (see the scheduled job
that calls it every 1-2h).
"""
import hashlib
import json
import os
import sys
from datetime import datetime, timezone

import openpyxl

SOURCE_PATH = r"\\WH-APP-WMS\usr_prio_encours$\emplacement_depot.xlsx"
REPO_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_PATH = os.path.join(REPO_DIR, "emplacements.txt")
META_PATH = os.path.join(REPO_DIR, "meta.json")
STATE_PATH = os.path.join(REPO_DIR, "scripts", ".last_source_hash")


def s(v):
    return "" if v is None else str(v)


def clip(v, default):
    try:
        v = float(v)
    except (TypeError, ValueError):
        return default
    return default if v > 2000 else v


def build():
    if not os.path.exists(SOURCE_PATH):
        print(f"Source file not found: {SOURCE_PATH}", file=sys.stderr)
        return False

    with open(SOURCE_PATH, "rb") as f:
        source_bytes = f.read()
    source_hash = hashlib.sha256(source_bytes).hexdigest()

    previous_hash = None
    if os.path.exists(STATE_PATH):
        previous_hash = open(STATE_PATH, encoding="utf-8").read().strip()
    if previous_hash == source_hash:
        print("Source unchanged, skipping rebuild.")
        return False

    wb = openpyxl.load_workbook(SOURCE_PATH, data_only=True, read_only=True)
    ws = wb.active
    rows = ws.iter_rows(values_only=True)
    header = next(rows)
    idx = {h: i for i, h in enumerate(header)}

    lines = []
    for r in rows:
        emplacement = s(r[idx["emplacement"]])
        if not emplacement:
            continue
        position = s(r[idx["position"]])
        niveau = s(r[idx["niveau"]])
        area = r[idx["area"]]
        area_c = "0" if area == "BJ-STOCK" else ("1" if area == "BJ-PICK" else "2")
        statut = s(r[idx["statut_emplacement"]]) or "X"
        allee = s(r[idx["allee"]])
        l = clip(r[idx["longueur"]], 80)
        w = clip(r[idx["largeur"]], 120)
        h = clip(r[idx["hauteur"]], 215)
        actif = "1" if r[idx["actif_non_actif"]] == 1 else "0"
        try:
            poids = int(r[idx["poids_max"]])
        except (TypeError, ValueError):
            poids = 0
        lines.append(
            f"{emplacement}|{position}|{niveau}|{area_c}|{statut}|{allee}|"
            f"{int(l)}|{int(w)}|{int(h)}|{actif}|{poids}"
        )

    with open(DATA_PATH, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))

    meta = {
        "generated_at": datetime.now(timezone.utc).astimezone().strftime("%d/%m/%Y %H:%M"),
        "row_count": len(lines),
        "source_path": SOURCE_PATH,
    }
    with open(META_PATH, "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)

    with open(STATE_PATH, "w", encoding="utf-8") as f:
        f.write(source_hash)

    print(f"Rebuilt {len(lines)} rows -> {DATA_PATH}")
    return True


if __name__ == "__main__":
    changed = build()
    sys.exit(0 if changed else 3)
