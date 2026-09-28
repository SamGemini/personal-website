"""Parse the Blue Torch Deal Book PDF into structured JSON.

Part one: deal-history table rows.  Part two: one record per pipeline company.
Text is taken verbatim from the PDF; only line-wraps are rejoined and
mojibake (UTF-8 read as cp1252) is repaired.
"""
import json, re, sys
import pymupdf
import ftfy

SRC = sys.argv[1]
OUT = sys.argv[2]

doc = pymupdf.open(SRC)


def fix(s):
    return ftfy.fix_text(s)


def join_lines(parts):
    out = ""
    for p in parts:
        p = p.strip()
        if not p:
            continue
        if not out:
            out = p
        elif out.endswith("-") and not out.endswith(" -"):
            out += p
        else:
            out += " " + p
    return fix(re.sub(r"\s+", " ", out)).strip()


def page_lines(pno):
    if pno not in _LINES:
        _LINES[pno] = _page_lines(pno)
    return _LINES[pno]


def _page_lines(pno):
    """Lines of a page with style info, header/footer removed, sorted by y then x."""
    res = []
    for b in doc[pno].get_text("dict")["blocks"]:
        for l in b.get("lines", []):
            sp = [s for s in l["spans"] if s["text"].strip()]
            if not sp:
                continue
            if sp[0]["font"].startswith("Arial"):
                continue  # browser print header/footer
            s = sp[0]
            res.append(dict(
                page=pno, x=l["bbox"][0], y=l["bbox"][1], x1=l["bbox"][2], y1=l["bbox"][3],
                font=s["font"], size=round(s["size"], 1), color=s["color"],
                text="".join(x["text"] for x in l["spans"]), spans=l["spans"],
            ))
    # field labels sit ~1pt below the first line of their value; sort them first
    def key(r):
        is_label = r["font"] == "SegoeUI-Bold" and r["size"] == 6.5 and abs(r["x"] - 40) < 3
        return (round(r["y"] - (3 if is_label else 0)), r["x"])
    res.sort(key=key)
    return res


_LINKS = {}


def page_links(pno):
    if pno not in _LINKS:
        _LINKS[pno] = [dict(rect=pymupdf.Rect(k["from"]), uri=k["uri"],
                            label=doc[pno].get_textbox(pymupdf.Rect(k["from"])).strip())
                       for k in doc[pno].get_links() if k.get("uri")]
    return _LINKS[pno]


_LINES = {}


def links_in(pno, y0, y1, x0=0):
    out = []
    for k in page_links(pno):
        cy = (k["rect"].y0 + k["rect"].y1) / 2
        if y0 - 1 <= cy <= y1 + 1 and k["rect"].x0 >= x0 - 1:
            label = k["label"]
            out.append(dict(label=fix(label), url=k["uri"], x=k["rect"].x0, y=k["rect"].y0))
    out.sort(key=lambda k: (round(k["y"]), k["x"]))
    return [dict(label=k["label"], url=k["url"]) for k in out]


# ---------------------------------------------------------------- locate parts
part2_page = next(i for i in range(len(doc)) if "Part two — lookalike pipeline" in doc[i].get_text())

# ---------------------------------------------------------------- header / intro
p0 = page_lines(0)
intro = dict(
    kicker=fix(p0[0]["text"]),
    title=fix(p0[1]["text"]),
    summary=join_lines([l["text"] for l in p0 if l["size"] == 9.4]),
    compiled=join_lines([l["text"] for l in p0 if l["size"] == 7.5 and l["text"].startswith("Compiled")]),
)
stats = []
big = [l for l in p0 if l["size"] == 14.2]
small = [l for l in p0 if l["size"] == 6.8]
for b in big:
    lab = min(small, key=lambda s: abs(s["x"] - b["x"]) + abs(s["y"] - b["y"] - 19))
    stats.append(dict(value=fix(b["text"]), label=fix(lab["text"]).title()))
intro["stats"] = stats

# ---------------------------------------------------------------- summary charts
def charts_on(pno, start_after=None, stop_at=None):
    """Label/count bar charts: a coloured heading, then label lines at the left and counts at the right."""
    lines = page_lines(pno)
    charts, cur, active = [], None, start_after is None
    for l in lines:
        t = l["text"].strip()
        if not active:
            active = t.startswith(start_after)
            continue
        if stop_at and t.startswith(stop_at):
            break
        if l["font"] == "SegoeUI-Bold" and l["size"] == 9.8 and l["color"] != 0x111418:
            cur = dict(title=fix(t), labels=[], counts=[])
            charts.append(cur)
        elif cur is not None and l["size"] == 7.1 and l["font"] == "SegoeUI":
            (cur["counts"] if l["x"] > 500 else cur["labels"]).append(l)
    out = []
    for c in charts:
        rows = []
        for n in c["counts"]:
            mid = (n["y"] + n["y1"]) / 2
            lab = [x["text"] for x in c["labels"] if abs((x["y"] + x["y1"]) / 2 - mid) < 8]
            rows.append([join_lines(lab), int(n["text"])])
        if rows:
            out.append(dict(title=c["title"], rows=rows))
    return out


intro["charts"] = charts_on(0, start_after="Part one", stop_at="Confirmed transactions")

# ---------------------------------------------------------------- part one table
COLS = [("date", 30, 76), ("company", 76, 204), ("sector", 204, 288),
        ("structure", 288, 432), ("size", 432, 510), ("role", 510, 700)]


def col_of(x):
    for name, a, b in COLS:
        if a <= x < b:
            return name
    return None


deals = []
deal_sections = []
cur = None
for pno in range(0, part2_page + 1):
    lines = page_lines(pno)
    if pno == part2_page:
        # stop at the part two heading
        stop_y = next(l["y"] for l in lines if l["text"].startswith("Part two"))
        lines = [l for l in lines if l["y"] < stop_y]
    started = pno > 0
    for l in lines:
        if not started:
            if l["text"] == "Confirmed transactions":
                started = True
                deal_sections.append(dict(title="Confirmed transactions", blurb=""))
            continue
        if l["font"] == "SegoeUI-Bold" and l["size"] == 9.8:
            deal_sections.append(dict(title=fix(l["text"]), blurb=""))
            cur = None
            continue
        if l["size"] == 7.5 and cur is None:
            deal_sections[-1]["blurb"] = join_lines([deal_sections[-1]["blurb"], l["text"]])
            continue
        if l["font"] == "SegoeUI-Bold" and l["size"] == 5.6:
            continue  # column header
        if l["size"] == 6.2 and abs(l["x"] - 33) < 3:
            cur = dict(cells={c[0]: [] for c in COLS}, note=[], page=pno, y0=l["y"], y1=l["y1"], notelines=[],
                       section=len(deal_sections) - 1)
            deals.append(cur)
        if cur is None:
            continue
        if l["size"] == 6.2:
            c = col_of(l["x"])
            cur["cells"][c].append(l["text"])
        elif l["size"] in (5.9, 6.5):
            cur["notelines"].append(l)
        else:
            print("part1 unhandled", pno, l["size"], l["text"][:60], file=sys.stderr)

out_deals = []
for dl in deals:
    row = {k: join_lines(v) for k, v in dl["cells"].items()}
    nl = dl["notelines"]
    note_text, sources = "", []
    if nl:
        pno = nl[0]["page"]
        # link labels live on the note lines; pull them out as sources
        sources = []
        ys = sorted({round(l["y"]) for l in nl})
        for y in ys:
            same = [l for l in nl if round(l["y"]) == y]
            sources += links_in(same[0]["page"], same[0]["y"], same[0]["y1"])
        labels = {s["label"] for s in sources}
        parts = []
        for l in nl:
            t = l["text"]
            if t.strip() in labels:
                continue
            parts.append(t)
        note_text = join_lines(parts)
        # strip link labels that ended up inline at the end of a line
        for lab in sorted(labels, key=len, reverse=True):
            if lab and note_text.endswith(" " + lab):
                note_text = note_text[: -len(lab) - 1].rstrip()
    row["note"] = note_text
    row["sources"] = sources
    row["section"] = dl["section"]
    out_deals.append(row)

# ---------------------------------------------------------------- part two
FIELD_X = 40
_seen_src_lines = set()


def add_sources(cur, pno, l):
    """A SOURCES row: linked labels become links, other text on the row is kept as plain source text."""
    key = (pno, round(l["y"]))
    if key in _seen_src_lines:
        return
    _seen_src_lines.add(key)
    row = [x for x in page_lines(pno) if abs(x["y"] - l["y"]) < 2.5 and x["x"] > 100 and x["size"] == 6.5]
    links = links_in(pno, l["y"], l["y1"], x0=100)
    labels = [k["label"] for k in links]
    cur["sources"] += links
    for x in row:
        t = x["text"].strip()
        if t and t not in labels:
            cur["sources"].append(dict(label=fix(t), url=None))
companies = []
tier = None
tier_blurb = []
cur = None
field = None
started = False
for pno in range(part2_page, len(doc)):
    for l in page_lines(pno):
        t = l["text"]
        if not started:
            if t.startswith("Part two"):
                started = True
            continue
        if t.startswith("Basis and limits.") or (cur is None and False):
            pass
        # end-matter paragraphs (8.2/7.x plain text after last company)
        if l["font"] == "SegoeUI-Bold" and l["size"] == 9.8 and l["color"] != 0x111418:
            # section heading (sector chart, tier)
            tier = fix(t)
            cur = None
            field = None
            continue
        if l["font"] == "SegoeUI-Bold" and l["size"] == 9.8 and l["color"] == 0x111418:
            cur = dict(name=[t], tier=tier, ticker="", fit="", descriptor=[], fields=[], page=pno + 1,
                       sources=[])
            companies.append(cur)
            field = None
            continue
        if cur is None:
            continue
        if l["font"] == "SegoeUI-Bold" and l["size"] == 9.8:
            continue
        if l["size"] == 7.1 and l["font"] == "SegoeUI-Semibold":
            cur["ticker"] = fix(t)
            continue
        if l["size"] == 7.1 and l["font"] == "SegoeUI-Bold" and t.startswith("Fit"):
            cur["fit"] = fix(t)
            continue
        if l["size"] == 7.1 and l["font"] == "SegoeUI" and not cur["fields"]:
            cur["descriptor"].append(t)
            continue
        if l["size"] == 6.5 and l["font"] == "SegoeUI-Bold" and abs(l["x"] - FIELD_X) < 3:
            field = dict(label=fix(t).strip(), lines=[], page=pno)
            cur["fields"].append(field)
            if field["label"] == "SOURCES":
                add_sources(cur, pno, l)
            continue
        if l["size"] == 6.5 and field is not None:
            if field["label"] == "SOURCES":
                add_sources(cur, pno, l)
                continue
            field["lines"].append(t)
            continue
        if l["size"] in (8.2, 7.5, 7.1, 6.8) and l["x"] < 35:
            # end matter at x=28
            cur = None
            continue
        print("part2 unhandled", pno, l["font"], l["size"], hex(l["color"]), round(l["x"]), t[:70], file=sys.stderr)

# name wrap: a long company name may wrap onto a second 9.8 line — handled above as a new company;
# detect and merge: a "company" with no fields immediately followed by another is a wrapped name.
merged = []
for c in companies:
    if merged and not merged[-1]["fields"] and not merged[-1]["descriptor"] and not merged[-1]["fit"]:
        merged[-1]["name"] += c["name"]
        for k in ("ticker", "fit", "descriptor", "fields", "sources"):
            merged[-1][k] = c[k] if not merged[-1][k] else merged[-1][k]
        continue
    merged.append(c)
companies = merged

out_comp = []
for i, c in enumerate(companies):
    fields = []
    for f in c["fields"]:
        if f["label"] == "SOURCES":
            continue
        fields.append(dict(label=f["label"].title(), text=join_lines(f["lines"])))
    tier_letter = (c["tier"] or "")[:1]
    fit = re.search(r"(\d+)/10", c["fit"] or "")
    # dedupe sources, keep order
    seen, srcs = set(), []
    for s in c["sources"]:
        k = s["url"] or s["label"]
        if k in seen:
            continue
        seen.add(k)
        srcs.append(s)
    out_comp.append(dict(
        id="c%03d" % (i + 1),
        name=join_lines(c["name"]),
        ticker=c["ticker"],
        fit=int(fit.group(1)) if fit else None,
        tier=c["tier"],
        tierLetter=tier_letter,
        descriptor=join_lines(c["descriptor"]),
        fields=fields,
        sources=srcs,
        page=c["page"],
    ))

# ---------------------------------------------------------------- part two intro + end matter
p2 = page_lines(part2_page)
p2_intro = []
buf = []
for l in p2:
    if l["size"] == 8.2:
        if l["font"] == "SegoeUI-Bold" and buf:
            p2_intro.append(join_lines(buf)); buf = []
        buf.append(l["text"])
if buf:
    p2_intro.append(join_lines(buf))

last = page_lines(len(doc) - 1)
end_matter, buf = [], []
for l in last:
    if l["x"] < 35 and l["size"] < 9:
        if l["text"].startswith(("Basis and limits.", "How part two was built.", "Part two is deal-origination")) and buf:
            end_matter.append(join_lines(buf)); buf = []
        buf.append(l["text"])
if buf:
    end_matter.append(join_lines(buf))

pipeline_charts = charts_on(part2_page, start_after="Part two", stop_at="A - ")
result = dict(intro=intro, pipelineCharts=pipeline_charts, dealSections=deal_sections, deals=out_deals, pipelineIntro=p2_intro,
              companies=out_comp, endMatter=end_matter)
json.dump(result, open(OUT, "w"), ensure_ascii=False, indent=1)

from collections import Counter
print("deals", len(out_deals), "companies", len(out_comp))
print("charts", [(c["title"], len(c["rows"]), sum(r[1] for r in c["rows"])) for c in intro["charts"] + pipeline_charts])
print("tiers", Counter(c["tier"] for c in out_comp))
print("field labels", Counter(f["label"] for c in out_comp for f in c["fields"]))
print("no ticker", sum(1 for c in out_comp if not c["ticker"]), "no fit", sum(1 for c in out_comp if c["fit"] is None),
      "no sources", sum(1 for c in out_comp if not c["sources"]))
print("deal sections", [(d["title"], sum(1 for x in out_deals if x["section"] == i)) for i, d in enumerate(deal_sections)])
print("text-only sources", sum(1 for c in out_comp for x in c["sources"] if not x["url"]))
print("deals without note", sum(1 for d in out_deals if not d["note"]), "without sources", sum(1 for d in out_deals if not d["sources"]))
