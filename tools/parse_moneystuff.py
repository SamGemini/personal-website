"""Parse the Money Stuff printable collection into one record per article.

Blocks: section headings (Georgia-Bold 12), paragraphs (Georgia 8.8), footnotes (Georgia 7.2).
Paragraphs are rebuilt from line geometry: a vertical gap larger than normal leading starts a
new paragraph. Text is otherwise verbatim.
"""
import json, re, sys
import pymupdf

SRC, OUT = sys.argv[1], sys.argv[2]
doc = pymupdf.open(SRC)

LEADING_BREAK = 16.0   # body leading is ~12.4pt; paragraph gaps are ~21pt
FULL_LINE_X1 = 505     # a line reaching this far right was wrapped, not ended


RIGHT_EDGE = 562.05    # text column right edge (widest line in the PDF)
SPACE_W = 2.12         # width of a space in Georgia 8.8 (measured between words)
MIN_ORPHAN_LINES = 3   # a paragraph continued onto the next page always leaves >= 3 lines behind
LIST_JOINERS = {"and", "or", "and/or", "but", "then", "plus", "minus", "times", "less", "nor"}
DEBUG = "--debug" in sys.argv


def first_word_widths(pno):
    """(block, line) -> width of the first word on that line, from word boxes."""
    out = {}
    for w in doc[pno].get_text("words"):
        key = (w[5], w[6])
        if key not in out:
            out[key] = w[2] - w[0]
    return out


def lines_of(pno):
    res = []
    fww = first_word_widths(pno)
    for bi, b in enumerate(doc[pno].get_text("dict")["blocks"]):
        for li, l in enumerate(b.get("lines", [])):
            sp = [s for s in l["spans"] if s["text"].strip()]
            if not sp:
                continue
            s = sp[0]
            if s["font"] == "ArialMT" and round(s["size"], 1) == 8.0:
                continue  # browser header/footer
            res.append(dict(page=pno, x=l["bbox"][0], y=l["bbox"][1], x1=l["bbox"][2], fw=fww.get((bi, li)),
                            font=s["font"], size=round(s["size"], 1), color=s["color"],
                            text="".join(x["text"] for x in l["spans"])))
    res.sort(key=lambda r: (round(r["y"], 1), r["x"]))
    return res


def join(a, b):
    if not a:
        return b.strip()
    a = a.rstrip()
    b = b.strip()
    if a.endswith("-") and not a.endswith(" -") and not a.endswith("--"):
        return a + b
    if a.endswith("—") and not a.endswith(" —"):
        return a + b  # closed-up em dash at a line end ("choice—" / "buying")
    return a + " " + b


articles = []
gap_run = 0   # body lines since the last paragraph gap, on the current page
art = None
state = None  # 'head', 'body', 'foot'
block = None  # current block being built
prev = None   # previous body line

for pno in range(len(doc)):
    links = [k for k in doc[pno].get_links() if k.get("uri")]
    for l in lines_of(pno):
        t = l["text"]
        if l["font"] == "Arial-BoldMT" and t.startswith("MONEY STUFF"):
            art = dict(kicker=t.strip(), title="", dek="", meta="", url="", blocks=[], footnotes=[], page=pno + 1)
            articles.append(art)
            state, block, prev = "head", None, None
            continue
        if art is None:
            continue
        if state == "head":
            if l["font"] == "Georgia-Bold" and l["size"] == 18.4:
                art["title"] = join(art["title"], t)
                continue
            if l["font"] == "Georgia" and l["color"] == 0x454545:
                art["dek"] = join(art["dek"], t)
                continue
            if l["font"] == "ArialMT" and l["size"] == 6.4:
                art["meta"] = join(art["meta"], t)
                continue
            if l["font"] == "ArialMT" and l["size"] == 5.6:
                art["url"] += t.strip()
                continue
            state = "body"
        if l["font"] == "Arial-BoldMT" and t.strip() == "FOOTNOTES":
            state, block, prev = "foot", None, None
            continue
        if l["font"] == "ArialMT" and l["size"] == 5.6 and l["color"] == 0x666666:
            art["disclaimer"] = join(art.get("disclaimer", ""), t)
            block, prev = None, None
            continue
        if state == "body":
            if l["font"] == "Georgia-Bold" and l["size"] == 12.0:
                if block and block["type"] == "h" and prev and prev["page"] == pno and l["y"] - prev["y"] < 16:
                    block["text"] = join(block["text"], t)
                else:
                    block = dict(type="h", text=t.strip())
                    art["blocks"].append(block)
                prev = l
                gap_run = 0
                continue
            if l["font"] in ("Georgia", "TimesNewRomanPSMT") and l["size"] == 8.8:
                if prev is None or prev["page"] != pno or (l["y"] - prev["y"]) > LEADING_BREAK:
                    new_gap_run = 1
                else:
                    new_gap_run = gap_run + 1
                new_para = True
                gap_break = fits = colon_break = orphan_break = False
                prev_t = cur_t = ""
                fw = 0
                if block and block["type"] == "p" and prev is not None:
                    gap_break = prev["page"] == pno and (l["y"] - prev["y"]) > LEADING_BREAK
                    # The previous line was wrapped only if this line's first word could not fit after it;
                    # otherwise it ended its paragraph (list items carry no extra gap).
                    fw = l["fw"] if l["fw"] is not None else 0
                    fits = prev["x1"] + SPACE_W + fw <= RIGHT_EDGE - 0.15  # tolerance for rounding
                    # A forced line break inside a sentence: previous line ends mid-phrase and this
                    # one starts in lower case ("…by the applicable" / "constitution, law…").
                    prev_t, cur_t = prev["text"].rstrip(), t.lstrip()
                    last_word = prev_t.split()[-1].lower() if prev_t.split() else ""
                    if fits and cur_t[:1].islower() and prev_t[-1:].isalnum() and last_word not in LIST_JOINERS:
                        fits = False
                    page_break = prev["page"] != pno
                    # Across a page break the paragraph gap is lost. A line ending in a colon there
                    # introduces a quote or list, and a block with fewer than 3 lines on the
                    # previous page cannot be continuing (the print layout never leaves fewer).
                    colon_break = page_break and prev_t.endswith(":")
                    orphan_break = page_break and gap_run < MIN_ORPHAN_LINES
                    new_para = gap_break or fits or colon_break or orphan_break
                if DEBUG and new_para and not gap_break and prev_t:
                    print("SPLIT", art["title"][:30], "|", "fits" if fits else "colon" if colon_break else "orphan", "| slack", round(RIGHT_EDGE - (prev["x1"] + SPACE_W + fw), 2), "|", prev_t[-40:], "||", cur_t[:40], file=sys.stderr)
                if new_para:
                    block = dict(type="p", text=t.strip(), _page=pno, _n=1, _lines=[(t.strip(), l["x1"])])
                    art["blocks"].append(block)
                else:
                    block["text"] = join(block["text"], t)
                    block["_lines"].append((t.strip(), l["x1"]))
                    if block.get("_page") == pno:
                        block["_n"] += 1
                gap_run = new_gap_run
                prev = l
                continue
        if state == "foot":
            if l["font"] == "Georgia" and l["size"] == 7.2:
                m = re.match(r"^(\d+)\.\s", t.strip())
                if m and l["x"] < 62:
                    block = dict(n=int(m.group(1)), text=t.strip()[len(m.group(0)):])
                    art["footnotes"].append(block)
                elif block is not None and "n" in block:
                    if prev is not None and prev["page"] == pno and (l["y"] - prev["y"]) > 13:
                        # a new paragraph inside the same footnote
                        block["text"] += "\n\n" + t.strip()
                    else:
                        block["text"] = join(block["text"], t)
                prev = l
                continue
        print("unhandled", pno, state, l["font"], l["size"], hex(l["color"]), round(l["x"]), t[:60], file=sys.stderr)

# ------------------------------------------------------------- footnote markers
# Markers are plain digits glued to the preceding word or punctuation ("that?1").  Pass 1 finds
# them strictly and in order (1, 2, 3...).  Pass 2 fills a missing marker n only inside the gap
# between markers n-1 and n+1, allowing the ambiguous shapes ("$100.3 Stock", "the US5:").
STRICT = r"(?:(?<=[a-z\?\!\)\]’”])|(?<=[^\d\s][\.,;:]))({n})(?=[\s\.\,;:\)’”\?\!—]|$)"
RELAXED = r"(?:(?<=\d\.)({n})(?=\s+[A-Z“‘(]|$))|(?:(?<=[A-Z])({n})(?=[:;,\.]))|(?:(?<=\d,)({n})(?=\s+[a-z]))"
for a in articles:
    paras = [b for b in a["blocks"] if b["type"] == "p"]
    text = "\n".join(b["text"] for b in paras)
    nmax = len(a["footnotes"])
    pos_of = {}
    pos = 0
    for n in range(1, nmax + 1):
        m = re.compile(STRICT.format(n=n), re.M).search(text, pos)
        if m:
            pos_of[n] = (m.start(), m.end())
            pos = m.end()
    for n in range(1, nmax + 1):
        if n in pos_of:
            continue
        lo = max([e for k, (s0, e) in pos_of.items() if k < n], default=0)
        hi = min([s0 for k, (s0, e) in pos_of.items() if k > n], default=len(text))
        m = re.compile(RELAXED.format(n=n), re.M).search(text, lo, hi)
        if m:
            pos_of[n] = (m.start(), m.end())
    # split paragraphs into runs
    marks = sorted((s0, e, n) for n, (s0, e) in pos_of.items())
    off = 0
    for b in paras:
        L = len(b["text"])
        mine = [(s0 - off, e - off, n) for s0, e, n in marks if off <= s0 < off + L]
        if mine:
            runs, cur = [], 0
            for s0, e, n in mine:
                if s0 > cur:
                    runs.append(b["text"][cur:s0])
                runs.append({"fn": n})
                cur = e
            if cur < L:
                runs.append(b["text"][cur:])
            b["runs"] = runs
        off += L + 1
    a["markersFound"] = len(pos_of)

# Section headings nested in a list lost their bold style in print and come out as body text.
# No layout rule separates them from short exclamations ("Sure?", "Reasonable!"), so these were
# identified one by one, each confirmed against the article's own dek.
# The list (article title -> heading texts, plus dek keyword -> heading) names article content, so it
# lives with the other private data: private/moneystuff-headings.json, passed as --headings.
_cfg = {}
if "--headings" in sys.argv:
    _cfg = json.load(open(sys.argv[sys.argv.index("--headings") + 1]))
BODY_FONT_HEADINGS = _cfg.get("bodyFontHeadings", {})
BODY_FONT_HEADINGS_BY_DEK = _cfg.get("bodyFontHeadingsByDek", {})
# Bloomberg promo boxes that were printed into the article body.
PROMO_BLOCKS = {
    "Bloomberg India is on WhatsApp",
    "Follow us on WhatsApp for the best of our journalism from India and beyond.",
    "Follow",
    "Leaders with Francine Lacqua",
    "What makes a leader successful? Learn from the people at the top. Candid lessons on leadership, management and the future of work.",
    "Watch the Podcast",
}

promoted, removed = [], 0
for a in articles:
    wanted = list(BODY_FONT_HEADINGS.get(a["title"], []))
    dek = a["dek"].lower()
    wanted += [h for key, h in BODY_FONT_HEADINGS_BY_DEK.items() if key in dek]
    out = []
    for b in a["blocks"]:
        if b["type"] == "p" and not b.get("runs") and b["text"].strip() in PROMO_BLOCKS:
            removed += 1
            continue
        if b["type"] == "p" and not b.get("runs") and b["text"].strip() in wanted:
            b["type"] = "h"
            promoted.append((a["title"], b["text"]))
            wanted.remove(b["text"].strip())
            out.append(b)
            continue
        # a heading glued onto the end of the paragraph before it
        lines = b.get("_lines") or []
        if b["type"] == "p" and len(lines) >= 2 and lines[-1][0].strip() in wanted and b["text"].endswith(lines[-1][0].strip()):
            h = lines[-1][0].strip()
            b["text"] = b["text"][: -len(h)].rstrip()
            if b.get("runs") and isinstance(b["runs"][-1], str) and b["runs"][-1].endswith(h):
                b["runs"][-1] = b["runs"][-1][: -len(h)].rstrip()
            out.append(b)
            out.append(dict(type="h", text=h))
            promoted.append((a["title"], h))
            wanted.remove(h)
            continue
        out.append(b)
    a["blocks"] = out
    if wanted:
        print("heading not found in", a["title"], wanted, file=sys.stderr)
print("body-font headings promoted", len(promoted), "| promo blocks removed", removed)

for a in articles:
    for b in a["blocks"]:
        b.pop("_page", None)
        b.pop("_n", None)
        b.pop("_lines", None)

# "Things happen" is the closing section of every issue; a few print it in body type.
for a in articles:
    for b in a["blocks"]:
        if b["type"] == "p" and b["text"].strip() == "Things happen":
            b["type"] = "h"
            b.pop("runs", None)

out = []
for i, a in enumerate(articles):
    m = re.search(r"Article (\d+) of (\d+)", a["meta"])
    date = a["meta"].split(" · ")[0] if a["meta"] else ""
    sections = [b["text"] for b in a["blocks"] if b["type"] == "h"]
    words = sum(len(b["text"].split()) for b in a["blocks"]) + sum(len(f["text"].split()) for f in a["footnotes"])
    out.append(dict(
        id="a%03d" % (i + 1),
        n=int(m.group(1)) if m else i + 1,
        title=a["title"], dek=a["dek"], date=date, meta=a["meta"], url=a["url"],
        sections=sections, blocks=a["blocks"], footnotes=a["footnotes"],
        disclaimer=a.get("disclaimer", ""), words=words, page=a["page"],
        markersFound=a["markersFound"],
    ))

json.dump(dict(title=doc.metadata.get("title", ""), articles=out), open(OUT, "w"), ensure_ascii=False, indent=1)
print("articles", len(out))
print("no url", [a["n"] for a in out if not a["url"]], "no title", [a["n"] for a in out if not a["title"]])
print("footnotes", sum(len(a["footnotes"]) for a in out), "markers", sum(a["markersFound"] for a in out))
print("marker shortfall", [(a["n"], a["markersFound"], len(a["footnotes"])) for a in out if a["markersFound"] != len(a["footnotes"])])
print("words", sum(a["words"] for a in out))
fn_gaps = [(a["n"], [f["n"] for f in a["footnotes"]]) for a in out if [f["n"] for f in a["footnotes"]] != list(range(1, len(a["footnotes"]) + 1))]
print("footnote numbering gaps", fn_gaps)
