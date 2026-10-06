#!/usr/bin/env python3
"""Convert specs/*.pdf to specs/*.md using pdfplumber.

Heuristics:
- Font size drives heading level (largest -> H1, etc.).
- Lines starting with bullet/number markers become markdown lists.
- pdfplumber's `extract_tables()` is used to render tables as GFM.
- Pages are separated by horizontal rules so each PDF page is locatable.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

import pdfplumber

SPECS_DIR = Path(__file__).resolve().parent.parent / "specs"
PAGE_BREAK = "\n\n---\n\n"

# Bullet/number markers at line start
LIST_RE = re.compile(r"^\s*([-•·▪◦∙]|\d+[.)]|[a-záéíóúñ][.)])\s+")
CHECKBOX_RE = re.compile(r"^\s*\[\s*[xX\s]?\s*\]\s*")


def classify_heading_level(size: float, body_size: float) -> int | None:
    """Return 1..4 if this size is meaningfully larger than body, else None.

    Tuned for the Notion-exported specs in this repo, where body=12pt,
    major section heads are ~16.5pt (~1.38×), and subsection heads ~13.5pt (~1.12×).
    """
    if size <= body_size * 1.05:
        return None
    if size >= body_size * 1.9:
        return 1
    if size >= body_size * 1.3:
        return 2
    if size >= body_size * 1.08:
        return 3
    return 4


def find_body_size(chars: list[dict]) -> float:
    """Most-common font size on the page = body text."""
    from collections import Counter

    sizes = [round(c["size"], 1) for c in chars]
    if not sizes:
        return 10.0
    return Counter(sizes).most_common(1)[0][0]


def group_chars_into_lines(chars: list[dict]) -> list[dict]:
    """Group chars into lines by y-position tolerance (sorted top-to-bottom)."""
    chars = sorted(chars, key=lambda c: (round(c["top"], 1), c["x0"]))
    lines: list[dict] = []
    current: dict | None = None
    for ch in chars:
        y_top = round(ch["top"], 1)
        if current is None or abs(y_top - current["y_top"]) <= 2:
            if current is None:
                current = {"chars": [], "y_top": y_top, "y_bot": round(ch["y1"], 1)}
            current["chars"].append(ch)
            current["y_bot"] = max(current["y_bot"], round(ch["y1"], 1))
        else:
            lines.append(current)
            current = {"chars": [ch], "y_top": y_top, "y_bot": round(ch["y1"], 1)}
    if current is not None:
        lines.append(current)
    return lines


def render_page(page, body_size: float) -> str:
    """Render one PDF page to markdown text."""
    out: list[str] = []

    # Tables — render after, so text-extraction can skip them.
    table_bboxes = page.find_tables()

    def in_table(y_top: float, y_bot: float) -> bool:
        for tbl in table_bboxes:
            x0, top, x1, bot = tbl.bbox
            if y_top >= top - 1 and y_bot <= bot + 1:
                return True
        return False

    # Footer/header chars are noticeably smaller than body (Notion exports use ~6pt).
    # The 6pt lines are the page header (top) and the "Page X of Y" footer (bottom).
    page_height = page.height
    HEADER_BAND = 30  # pt from top
    FOOTER_BAND = 30  # pt from bottom

    lines = group_chars_into_lines(page.chars)
    for ln in lines:
        if in_table(ln["y_top"], ln["y_bot"]):
            continue
        line_chars = sorted(ln["chars"], key=lambda c: c["x0"])
        line_text = "".join(c["text"] for c in line_chars).strip()
        if not line_text:
            out.append("")
            continue
        max_size = max(c["size"] for c in line_chars)
        # Strip Notion page header (top, small) and page-number footer (bottom, small).
        if max_size < body_size * 0.7:
            if ln["y_top"] < HEADER_BAND or ln["y_top"] > page_height - FOOTER_BAND:
                continue
        # Heading?
        h = classify_heading_level(max_size, body_size)
        if h and not LIST_RE.match(line_text) and not CHECKBOX_RE.match(line_text):
            out.append("#" * h + " " + line_text)
        else:
            out.append(line_text)

    # Tables
    for table in page.find_tables():
        rows = table.extract()
        if not rows:
            continue
        cleaned = [[(c or "").strip().replace("\n", " ") for c in r] for r in rows]
        cleaned = [r for r in cleaned if any(c for c in r)]
        if not cleaned:
            continue
        header, *body_rows = cleaned
        width = max(len(header), max((len(r) for r in body_rows), default=0))
        header = header + [""] * (width - len(header))
        sep = ["---"] * width
        if out and out[-1] != "":
            out.append("")
        out.append("| " + " | ".join(header) + " |")
        out.append("| " + " | ".join(sep) + " |")
        for r in body_rows:
            r = r + [""] * (width - len(r))
            out.append("| " + " | ".join(r) + " |")
        out.append("")

    text = "\n".join(out)

    # Merge heading lines that are split across PDF text-wrap (e.g. a title
    # that the PDF broke onto two lines, each detected as its own heading).
    text = re.sub(r"^(#{1,6}) (.+)\n\1 (.+)$", r"\1 \2 \3", text, flags=re.M)

    return re.sub(r"\n{3,}", "\n\n", text).strip()


def convert(pdf_path: Path, md_path: Path) -> None:
    print(f"📄 {pdf_path.name}  →  {md_path.name}")
    with pdfplumber.open(pdf_path) as pdf:
        parts: list[str] = []
        for i, page in enumerate(pdf.pages, start=1):
            body = find_body_size(page.chars)
            parts.append(render_page(page, body))
        full = ("\n" + PAGE_BREAK + "\n").join(parts) + "\n"
    md_path.write_text(full, encoding="utf-8")
    print(f"   ✅ {md_path.stat().st_size:,} bytes, {full.count(chr(10))} líneas")


if __name__ == "__main__":
    pdfs = sorted(SPECS_DIR.glob("*.pdf"))
    if not pdfs:
        print("No PDFs found in specs/")
        sys.exit(1)
    for pdf in pdfs:
        convert(pdf, pdf.with_suffix(".md"))