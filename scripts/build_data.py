"""Regenerate emplacements.txt + meta.json from the SAP BI export.

Reads the emplacement_depot_<id>.xlsx export dropped on the SAP BO network
share and converts it to the compact pipe-delimited format the 3D map
fetches at runtime. Once successfully processed, the source file is moved
to a "processed" subfolder on the same share (not deleted) so it never gets
reprocessed, while staying recoverable if something goes wrong downstream.
"""
import glob
import json
import os
import shutil
import sys
from datetime import datetime, timezone

import openpyxl

SOURCE_DIR = r"\\vm-apps-shares.babou.local\SAP_BO\EXPORTS\BLUEYONDER"
SOURCE_GLOB = "emplacement_depot_*.xlsx"
PROCESSED_DIR = os.path.join(SOURCE_DIR, "processed")

REPO_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_PATH = os.path.join(REPO_DIR, "emplacements.txt")
META_PATH = os.path.join(REPO_DIR, "meta.json")


def s(v):
    return "" if v is None else str(v)


def clip(v, default):
    try:
        v = float(v)
    except (TypeError, ValueError):
        return default
    return default if v > 2000 else v


def storage_type(raw):
    # raw looks like "ZS-<cellule>-<type>", e.g. "ZS-J-STOCK", "ZS-B-TYPE-1-2",
    # "ZS-BJ-ZBPSTOCK" -> keep only the meaningful suffix (STOCK, PICKING,
    # FPP, LOURDSOL, HAUTSTOCK, CAGE, ...), dropping the "ZS-<cellule>-" prefix.
    raw = s(raw).strip()
    parts = raw.split("-")
    if len(parts) >= 3 and parts[0].upper() == "ZS":
        return "-".join(parts[2:])
    return raw or "NON_DEFINI"


def find_source_files():
    matches = glob.glob(os.path.join(SOURCE_DIR, SOURCE_GLOB))
    # newest first: several exports can pile up if this job missed a run or
    # two (e.g. the scheduler was offline) — only the newest is a full
    # snapshot worth building from, but ALL of them must be archived so they
    # don't just sit there and get mistaken for "not yet processed" next time
    matches.sort(key=os.path.getmtime, reverse=True)
    return matches


def build():
    source_paths = find_source_files()
    if not source_paths:
        print(f"No file matching {SOURCE_GLOB} in {SOURCE_DIR}", file=sys.stderr)
        return False
    source_path = source_paths[0]
    stale_paths = source_paths[1:]
    if stale_paths:
        print(f"Found {len(stale_paths)} older export(s) alongside the newest one — archiving them unread, they are superseded.")

    wb = openpyxl.load_workbook(source_path, data_only=True, read_only=True)
    ws = wb.active
    rows = ws.iter_rows(values_only=True)
    header = next(rows)
    idx = {str(h).strip().lower(): i for i, h in enumerate(header)}

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
        stype = storage_type(r[idx["type_stockage"]]) if "type_stockage" in idx else "NON_DEFINI"
        lines.append(
            f"{emplacement}|{position}|{niveau}|{area_c}|{statut}|{allee}|"
            f"{int(l)}|{int(w)}|{int(h)}|{actif}|{poids}|{stype}"
        )

    wb.close()  # release the file handle before moving the source file below

    with open(DATA_PATH, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(lines))

    meta = {
        "generated_at": datetime.now(timezone.utc).astimezone().strftime("%d/%m/%Y %H:%M"),
        "row_count": len(lines),
        "source_file": os.path.basename(source_path),
    }
    with open(META_PATH, "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)

    # only touch the source files once the new data + meta are safely written
    os.makedirs(PROCESSED_DIR, exist_ok=True)
    for p in [source_path] + stale_paths:
        shutil.move(p, os.path.join(PROCESSED_DIR, os.path.basename(p)))

    print(f"Rebuilt {len(lines)} rows from {os.path.basename(source_path)} -> {DATA_PATH}")
    if stale_paths:
        print(f"Archived {len(stale_paths)} superseded export(s) too.")
    return True


if __name__ == "__main__":
    changed = build()
    sys.exit(0 if changed else 3)
