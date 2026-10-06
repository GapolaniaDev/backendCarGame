#!/usr/bin/env python3
"""Scan specs/Checklist*.md and print progress per phase.

Counts `- [x]` vs `- [ ]` under each `## Fase N` heading.
Renderable progress bars use unicode block characters (terminal-friendly).

Usage:
    python3 scripts/progress.py             # show overall + per-phase summary
    python3 scripts/progress.py --open     # list items that are NOT done (actionable)
    python3 scripts/progress.py --phase 1   # only show Fase N
"""

from __future__ import annotations

import argparse
import re
from pathlib import Path

SPECS_DIR = Path(__file__).resolve().parent.parent / "specs"
CHECKLIST = next(SPECS_DIR.glob("Checklist*.md"), None)
PHASE_RE = re.compile(r"^## Fase (\d+) — (.+)$")
ITEM_DONE_RE = re.compile(r"^- \[x\] ", re.IGNORECASE)
ITEM_OPEN_RE = re.compile(r"^- \[ \] ")


def parse_checklist(path: Path) -> list[dict]:
    """Return list of phases with their done/open items (preserving item order)."""
    phases: dict[int, dict] = {}
    current: dict | None = None
    for line in path.read_text(encoding="utf-8").split("\n"):
        m = PHASE_RE.match(line.strip())
        if m:
            n = int(m.group(1))
            current = {
                "n": n,
                "title": m.group(2),
                "done": 0,
                "open": 0,
                "open_items": [],  # text of unchecked items for --open view
            }
            phases[n] = current
            continue
        if current is None:
            continue
        if ITEM_DONE_RE.match(line):
            current["done"] += 1
        elif ITEM_OPEN_RE.match(line):
            current["open"] += 1
            current["open_items"].append(line[len("- [ ] "):].strip())
    return [phases[k] for k in sorted(phases)]


def bar(done: int, total: int, width: int = 16) -> str:
    if total == 0:
        return " " * width
    filled = round(width * done / total)
    return "█" * filled + "░" * (width - filled)


def pct(done: int, total: int) -> int:
    return round(100 * done / total) if total else 0


def print_summary(phases: list[dict]) -> None:
    total_done = sum(p["done"] for p in phases)
    total_open = sum(p["open"] for p in phases)
    grand = total_done + total_open
    print(f"\n📊 {CHECKLIST.name}\n")
    print(f"  {'Fase':<6}  {'Progreso':<22}  {'%':>4}  Items")
    print(f"  {'-'*6}  {'-'*22}  {'-'*4}  -----")
    for p in phases:
        total = p["done"] + p["open"]
        print(f"  {p['n']:<6}  {bar(p['done'], total):<22}  {pct(p['done'], total):>3}%  {p['done']}/{total}  {p['title']}")
    print(f"  {'-'*6}  {'-'*22}  {'-'*4}  -----")
    print(f"  {'Total':<6}  {bar(total_done, grand):<22}  {pct(total_done, grand):>3}%  {total_done}/{grand}\n")


def print_open(phases: list[dict], only_n: int | None = None) -> None:
    print(f"\n📝 Items sin marcar:\n")
    found = 0
    for p in phases:
        if only_n is not None and p["n"] != only_n:
            continue
        if not p["open_items"]:
            continue
        print(f"  Fase {p['n']} — {p['title']}  ({p['open']} pendientes)")
        for item in p["open_items"]:
            print(f"    • {item}")
        print()
        found += p["open"]
    if found == 0:
        print("  ✅ Todo marcado.\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    parser.add_argument("--open", action="store_true", dest="open_",
                        help="list unchecked items")
    parser.add_argument("--phase", type=int, help="only show one phase")
    args = parser.parse_args()

    if CHECKLIST is None:
        raise SystemExit("No Checklist*.md found in specs/")
    phases = parse_checklist(CHECKLIST)
    if args.open_:
        print_open(phases, only_n=args.phase)
    else:
        print_summary(phases)
        if args.phase is None:
            print("  Tip: --open para listar pendientes, --phase N para ver una fase.\n")