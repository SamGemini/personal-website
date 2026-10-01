// Reading pages: one checkable, note-taking section per company or article.
// Progress and notes are saved in this browser (localStorage); Export/Import moves them between devices.
(() => {
  const app = document.getElementById("app");
  const COLL = document.body.dataset.coll || null;
  const CHECK = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5l3.2 3L13 4.5" fill="none" stroke="var(--accent-ink)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  const KNOWN = { bluetorch: /^(deals|c\d{3})$/, moneystuff: /^a\d{3}$/ };
  const validId = (coll, id) => !!(KNOWN[coll] && KNOWN[coll].test(id));
  const sel = v => (window.CSS && CSS.escape) ? CSS.escape(String(v)) : String(v).replace(/["\\\]]/g, "\\$&");
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const safeUrl = u => /^https?:\/\//i.test(u || "") ? u : null;
  const fmt = n => n.toLocaleString("en-US");

  // ------------------------------------------------------------------ progress store
  const Store = {
    state: {},
    listeners: new Set(),
    key: coll => "reading-desk:progress:" + coll,
    load(coll) {
      try { this.state[coll] = JSON.parse(localStorage.getItem(this.key(coll)) || "{}") || {}; }
      catch (e) { this.state[coll] = this.state[coll] || {}; }
      return this.state[coll];
    },
    get(coll, id) { return (this.state[coll] || {})[id] || { read: false, note: "" }; },
    set(coll, id, patch) {
      this.state[coll] = this.state[coll] || {};
      const next = { ...this.get(coll, id), ...patch, at: new Date().toISOString() };
      if (!next.read && !(next.note || "").trim()) delete this.state[coll][id];
      else this.state[coll][id] = next;
      this.save(coll);
      this.listeners.forEach(fn => fn(coll, id));
    },
    save(coll) {
      try {
        localStorage.setItem(this.key(coll), JSON.stringify(this.state[coll] || {}));
        this.ok = true;
      } catch (e) { this.ok = false; }
    },
    ok: true,
  };
  const readCount = coll => Object.entries(Store.state[coll] || {}).filter(([id, v]) => validId(coll, id) && v && v.read).length;

  // Another tab changed progress: pick it up.
  window.addEventListener("storage", e => {
    if (!e.key || !e.key.startsWith("reading-desk:progress:")) return;
    const coll = e.key.slice("reading-desk:progress:".length);
    if (!KNOWN[coll]) return;
    Store.load(coll);
    Store.listeners.forEach(fn => fn(coll, null));
  });

  function exportProgress(colls) {
    const data = { app: "reading-desk", version: 1, exportedAt: new Date().toISOString(), progress: {} };
    colls.forEach(c => data.progress[c] = Store.load(c));
    const blob = new Blob([JSON.stringify(data, null, 1)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "reading-desk-progress-" + new Date().toISOString().slice(0, 10) + ".json";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  function importProgress(file, done) {
    const r = new FileReader();
    r.onload = () => {
      let data;
      try { data = JSON.parse(r.result); } catch (e) { done("That file isn't a progress backup."); return; }
      if (!data || data.app !== "reading-desk" || typeof data.progress !== "object" || !data.progress) { done("That file isn't a progress backup."); return; }
      let n = 0, skipped = 0;
      try {
        for (const coll of Object.keys(KNOWN)) {
          const items = data.progress[coll];
          if (!items || typeof items !== "object") continue;
          const mine = Store.load(coll);
          for (const [id, v] of Object.entries(items)) {
            if (!validId(coll, id) || !v || typeof v !== "object") { skipped++; continue; }
            const cur = mine[id] || { read: false, note: "" };
            const a = String(cur.note || "").trim();
            const b = typeof v.note === "string" ? v.note.trim() : "";
            const note = !a ? b : !b || a === b ? a : a + "\n\n---\n" + b;
            mine[id] = { read: !!(cur.read || v.read === true), note, at: cur.at || (typeof v.at === "string" ? v.at : undefined) };
            n++;
          }
          Store.save(coll);
          Store.listeners.forEach(fn => fn(coll, null));
        }
      } catch (e) {
        done("Couldn't import that file: " + (e.message || e));
        return;
      }
      done(`Imported ${n} saved section${n === 1 ? "" : "s"}${skipped ? ` (skipped ${skipped} unrecognised)` : ""}.`);
    };
    r.onerror = () => done("Couldn't read that file.");
    r.readAsText(file);
  }

  function backupHtml() {
    return `<span class="backup">
      <button class="linkbtn" data-export>Export progress</button>
      <label class="linkbtn" for="import-file">Import progress</label>
      <input id="import-file" type="file" accept="application/json,.json" hidden>
      <span class="store-note" data-backup-msg></span>
    </span>`;
  }

  function bindBackup(root, colls) {
    root.querySelector("[data-export]").addEventListener("click", () => exportProgress(colls));
    const input = root.querySelector("#import-file");
    input.addEventListener("change", () => {
      const f = input.files && input.files[0];
      if (!f) return;
      importProgress(f, msg => { root.querySelector("[data-backup-msg]").textContent = msg; input.value = ""; });
    });
  }

  // ------------------------------------------------------------------ home
  async function startHome(key, load) {
    const manifest = await load("manifest");
    const colls = manifest.collections;
    // Entries with a `url` are links to outside apps (e.g. Leer): no reader page, no read count.
    const readers = colls.filter(c => !safeUrl(c.url));
    readers.forEach(c => Store.load(c.id));
    const draw = () => {
      app.className = "wrap home";
      app.innerHTML = `<div class="topline"><h1 style="margin:0">Reading Desk</h1><button class="linkbtn" data-lock>Lock</button></div>
        <ul class="shelf" style="margin-top:2rem">${colls.map(c => { const ext = safeUrl(c.url); return `<li><a href="${esc(ext || (/^[a-z0-9-]+\/$/.test(c.path) ? c.path : "./"))}"${ext ? ' rel="noopener noreferrer"' : ""}><span class="t">${esc(c.title)}</span>
          <span class="s">${esc(c.blurb)}${ext ? "" : ` · <span class="num">${readCount(c.id)}/${esc(c.total)}</span> read`}</span>
          <span class="go" aria-hidden="true">${ext ? "↗" : "→"}</span></a></li>`; }).join("")}</ul>
        <div style="margin-top:1.5rem">${backupHtml()}</div>`;
      app.querySelector("[data-lock]").addEventListener("click", () => Vault.lock());
      bindBackup(app, readers.map(c => c.id));
    };
    Store.listeners.add(() => draw());
    draw();
  }

  // ------------------------------------------------------------------ reader data
  function build(coll, data) {
    const items = [];
    if (coll === "bluetorch") {
      items.push({
        id: "deals", group: "Part one", title: "Blue Torch deal history",
        sub: `${data.deals.length} financings, 2018–2026`, meta: [],
        hay: ("blue torch deal history " + data.deals.map(d => [d.company, d.sector, d.structure, d.note].join(" ")).join(" ")).toLowerCase(),
        render: () => renderDeals(data),
      });
      for (const c of data.companies) {
        const tierName = data.tiers[c.tierLetter] || c.tierLetter;
        items.push({
          id: c.id, group: "Part two · " + tierName.replace(/\s*\(\d+\)$/, ""), tier: c.tierLetter,
          title: c.name, sub: c.ticker,
          meta: [c.fit != null ? `Fit ${c.fit}/10` : "Unscored", `PDF p. ${c.page}`],
          hay: [c.name, c.ticker, c.descriptor, ...c.fields.map(f => f.text)].join(" ").toLowerCase(),
          render: () => renderCompany(c),
        });
      }
    } else {
      for (const a of data.articles) {
        const mins = Math.max(1, Math.round(a.words / 230));
        items.push({
          id: a.id, title: a.title, sub: a.dek,
          meta: [shortDate(a.date), `${fmt(a.words)} words`, `${mins} min`],
          hay: [a.title, a.dek, ...a.blocks.map(b => b.h || b.p || (b.r || []).map(x => typeof x === "string" ? x : "").join(""))].join(" ").toLowerCase(),
          render: () => renderArticle(a),
        });
      }
    }
    return { data, items, index: Object.fromEntries(items.map(i => [i.id, i])) };
  }

  function shortDate(s) {
    const m = /^([A-Za-z]+) (\d+), (\d{4})/.exec(s || "");
    return m ? `${m[1].slice(0, 3)} ${m[2]}, ${m[3]}` : (s || "");
  }

  // ------------------------------------------------------------------ renderers
  function sourcesHtml(list) {
    if (!list || !list.length) return "";
    return '<ul class="sources">' + list.map(s => {
      const u = safeUrl(s.url);
      return "<li>" + (u ? `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(s.label || u)}</a>` : `<span>${esc(s.label)}</span>`) + "</li>";
    }).join("") + "</ul>";
  }

  function renderCompany(c) {
    const fields = c.fields.filter(f => f.label !== "Review Note").map(f =>
      `<div class="field"><dt class="label">${esc(f.label)}</dt><dd>${esc(f.text)}</dd></div>`).join("");
    const review = c.fields.filter(f => f.label === "Review Note").map(f =>
      `<div class="review"><span class="label">Review note · unapplied reviewer corrections</span><p>${esc(f.text)}</p></div>`).join("");
    return `<p class="descriptor">${esc(c.descriptor)}</p>
      <dl class="fields">${fields}</dl>
      ${review}
      <div><div class="label" style="margin-bottom:.4rem">Sources</div>${sourcesHtml(c.sources)}</div>`;
  }

  function renderDeals(data) {
    return data.dealSections.map((sec, i) => {
      const deals = data.deals.filter(d => d.section === i);
      return `<section class="deal-sec"><h3>${esc(sec.title)} <span class="num" style="color:var(--muted);font-weight:400">(${deals.length})</span></h3>
        ${sec.blurb ? `<p>${esc(sec.blurb)}</p>` : ""}
        ${deals.map(d => `<div class="deal">
          <div class="deal-top"><span class="num label">${esc(d.date)}</span><b>${esc(d.company)}</b></div>
          <div class="deal-grid">
            <div><span class="label">Sector</span><span>${esc(d.sector)}</span></div>
            <div><span class="label">Structure</span><span>${esc(d.structure)}</span></div>
            <div><span class="label">Size</span><span>${esc(d.size)}</span></div>
            <div><span class="label">Blue Torch role</span><span>${esc(d.role)}</span></div>
          </div>
          ${d.note ? `<p>${esc(d.note)}</p>` : ""}
          ${sourcesHtml(d.sources)}
        </div>`).join("")}</section>`;
    }).join("");
  }

  function renderArticle(a) {
    const body = a.blocks.map(b => {
      if (b.h) return `<h3>${esc(b.h)}</h3>`;
      if (b.p) return `<p>${esc(b.p)}</p>`;
      return "<p>" + b.r.map(x => typeof x === "string" ? esc(x)
        : `<button class="fnref" data-fn="${esc(x.fn)}" aria-label="Footnote ${esc(x.fn)}">${esc(x.fn)}</button>`).join("") + "</p>";
    }).join("");
    const fns = a.footnotes.length ? `<div class="footnotes"><div class="label">Footnotes</div><ol>${a.footnotes.map(f =>
      `<li data-fnli="${esc(f.n)}" value="${esc(f.n)}">${esc(f.text).replace(/\n\n/g, "<br><br>")} <button class="fnback" data-fnback="${esc(f.n)}" aria-label="Back to text">↩</button></li>`).join("")}</ol></div>` : "";
    const u = safeUrl(a.url);
    return `<div class="article">
      <p class="src">${esc(a.date)}${u ? ` · <a href="${esc(u)}" target="_blank" rel="noopener noreferrer">Open on Bloomberg</a>` : ""}</p>
      ${body}${fns}
      ${a.disclaimer ? `<p class="disclaimer">${esc(a.disclaimer)}</p>` : ""}
    </div>`;
  }

  // ------------------------------------------------------------------ reader view
  const view = { filter: "all", tier: "all", q: "", open: null };
  let R = null; // { data, items, index }

  async function startReader(key, load) {
    app.innerHTML = `<div class="loading">Decrypting…</div>`;
    const data = await load(COLL);
    Store.load(COLL);
    R = build(COLL, data);
    document.title = (data.heading || "Reading") + " · Reading Desk";
    app.className = "wrap reader";
    app.innerHTML = readerShell(data);
    bindReader();
    drawList();
  }

  function chartsHtml(charts) {
    if (!charts || !charts.length) return "";
    return `<div class="charts">${charts.map(c => {
      const max = Math.max(1, ...c.rows.map(r => Number(r[1]) || 0));
      return `<figure class="chart"><figcaption class="label">${esc(c.title)}</figcaption>
        ${c.rows.map(r => `<div class="chart-row"><span class="chart-label">${esc(r[0])}</span>
          <span class="chart-bar"><i style="width:${(100 * (Number(r[1]) || 0) / max).toFixed(1)}%"></i></span>
          <span class="num">${esc(r[1])}</span></div>`).join("")}
      </figure>`;
    }).join("")}</div>`;
  }

  function readerShell(d) {
    let intro = "", tierSeg = "";
    if (COLL === "bluetorch") {
      intro = `<div class="label">${esc(d.kicker)}</div><h1>${esc(d.title)}</h1>
        <p class="lede">${esc(d.summary)}</p>
        <details class="about"><summary>About this deal book</summary><div class="about-body">
          <div class="stats">${d.stats.map(s => `<div><b>${esc(s.value)}</b><span class="label">${esc(s.label)}</span></div>`).join("")}</div>
          <p>${esc(d.compiled)}</p>
          ${chartsHtml(d.charts)}
          ${d.pipelineIntro.map(p => `<p>${esc(p)}</p>`).join("")}
          ${chartsHtml(d.pipelineCharts)}
          ${d.endMatter.map(p => `<p>${esc(p)}</p>`).join("")}
        </div></details>`;
      const counts = { A: 0, B: 0, C: 0 };
      d.companies.forEach(c => counts[c.tierLetter] = (counts[c.tierLetter] || 0) + 1);
      tierSeg = `<div class="seg" role="group" aria-label="Tier">
        <button data-tier="all" aria-pressed="true">All tiers</button>
        ${["A", "B", "C"].map(t => `<button data-tier="${t}" aria-pressed="false" title="${esc(d.tiers[t] || t)}">${t} <span class="num">${counts[t]}</span></button>`).join("")}
      </div>`;
    } else {
      intro = `<div class="label">${esc(d.kicker || "")}</div><h1>${esc(d.heading || "")}</h1>
        <p class="lede">${d.articles.length} newsletters, newest first: ${esc(shortDate(d.articles[0].date))} back to ${esc(shortDate(d.articles[d.articles.length - 1].date))}.</p>`;
    }
    return `<div class="topline"><a class="back" href="../">← Reading Desk</a><button class="linkbtn" data-lock>Lock</button></div>
      ${intro}
      <div class="progress">
        <div class="progress-line"><span><b class="num" data-read>0</b> of <span class="num">${R.items.length}</span> read</span>${backupHtml()}</div>
        <div class="bar"><i data-bar></i></div>
        <div class="store-note" data-store></div>
      </div>
      <div class="toolbar">
        <input class="search" id="search" type="search" placeholder="Search ${COLL === "bluetorch" ? "companies" : "articles"}…" aria-label="Search">
        <div class="seg" role="group" aria-label="Show">
          <button data-filter="all" aria-pressed="true">All</button>
          <button data-filter="unread" aria-pressed="false">Unread</button>
          <button data-filter="read" aria-pressed="false">Read</button>
        </div>
        ${tierSeg}
        <button class="btn" data-next>Next unread</button>
      </div>
      <div class="count" data-count></div>
      <div class="list" data-list></div>`;
  }

  function itemHead(it) {
    const s = Store.get(COLL, it.id);
    const tierChip = /^[ABC]$/.test(it.tier || "") ? `<span class="tier ${it.tier}">Tier ${it.tier}</span>` : "";
    const metas = it.meta.map(m => `<span class="m">${esc(m)}</span>`).join("");
    const note = s.note && s.note.trim() ? `<span class="has-note">✎ Note</span>` : "";
    const subIsDek = COLL === "moneystuff";
    return `<div class="item-head">
      <button class="check" role="checkbox" aria-checked="${s.read ? "true" : "false"}" data-check="${esc(it.id)}" aria-label="Mark “${esc(it.title)}” as read">${CHECK}</button>
      <button class="toggle" data-toggle="${esc(it.id)}" aria-expanded="${view.open === it.id}" aria-controls="body-${esc(it.id)}">
        <span class="item-title">${esc(it.title)}</span>
        ${it.sub ? `<span class="item-sub">${subIsDek ? `<span class="dek">${esc(it.sub)}</span>` : esc(it.sub)}</span>` : ""}
        <span class="meta">${tierChip}${metas}${note}</span>
      </button>
    </div>`;
  }

  function visibleItems(filter = view.filter) {
    const q = view.q.trim().toLowerCase();
    return R.items.filter(it => {
      const s = Store.get(COLL, it.id);
      if (filter === "read" && !s.read) return false;
      if (filter === "unread" && s.read) return false;
      if (view.tier !== "all" && it.tier !== view.tier) return false;
      if (q && !q.split(/\s+/).every(w => it.hay.includes(w) || (s.note || "").toLowerCase().includes(w))) return false;
      return true;
    });
  }

  function bindReader() {
    const search = app.querySelector("#search");
    let t;
    search.addEventListener("input", () => {
      clearTimeout(t);
      t = setTimeout(() => { view.q = search.value; drawList(); }, 150);
    });
    app.querySelector("[data-lock]").addEventListener("click", () => Vault.lock());
    bindBackup(app, [COLL]);
    app.addEventListener("click", e => {
      const b = e.target.closest("button");
      if (!b || !app.contains(b)) return;
      if (b.dataset.filter) { view.filter = b.dataset.filter; drawList(); syncSeg(); }
      else if (b.dataset.tier) { view.tier = b.dataset.tier; drawList(); syncSeg(); }
      else if (b.hasAttribute("data-next")) openNextUnread(null);
      else if (b.dataset.check) {
        const s = Store.get(COLL, b.dataset.check);
        Store.set(COLL, b.dataset.check, { read: !s.read });
      }
      else if (b.dataset.toggle) toggle(b.dataset.toggle);
      else if (b.dataset.done) {
        Store.set(COLL, b.dataset.done, { read: true });
        openNextUnread(b.dataset.done);
      }
      else if (b.dataset.collapse) toggle(b.dataset.collapse);
      else if (b.dataset.fn) {
        const li = b.closest(".item").querySelector(`[data-fnli="${sel(b.dataset.fn)}"]`);
        if (li) { li.scrollIntoView({ block: "center" }); flash(li); }
      }
      else if (b.dataset.fnback) {
        const ref = b.closest(".item").querySelector(`.fnref[data-fn="${sel(b.dataset.fnback)}"]`);
        if (ref) { ref.scrollIntoView({ block: "center" }); ref.focus({ preventScroll: true }); }
      }
    });
    app.addEventListener("input", e => {
      const ta = e.target;
      if (!ta.dataset || !ta.dataset.note) return;
      setSaveState(ta.dataset.note, "Editing…");
      clearTimeout(ta._t);
      ta._t = setTimeout(() => saveNote(ta), 500);
    });
    app.addEventListener("focusout", e => {
      const ta = e.target;
      if (!ta.dataset || !ta.dataset.note) return;
      clearTimeout(ta._t);
      if ((Store.get(COLL, ta.dataset.note).note || "") !== ta.value) saveNote(ta);
    });
    Store.listeners.add(onStoreChange);
  }

  function saveNote(ta) {
    Store.set(COLL, ta.dataset.note, { note: ta.value });
    setSaveState(ta.dataset.note, Store.ok ? "Saved in this browser" : "Couldn't save: this browser is blocking storage");
  }
  function setSaveState(id, text) {
    const el = app.querySelector(`[data-save="${sel(id)}"]`);
    if (el) el.textContent = text;
  }

  function flash(el) { el.classList.add("flash"); setTimeout(() => el.classList.remove("flash"), 1200); }

  function syncSeg() {
    app.querySelectorAll("[data-filter]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.filter === view.filter)));
    app.querySelectorAll("[data-tier]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.tier === view.tier)));
  }

  function drawList() {
    const list = app.querySelector("[data-list]");
    const vis = visibleItems();
    const total = R.items.length;
    app.querySelector("[data-count]").textContent = vis.length === total ? `${total} sections` : `Showing ${vis.length} of ${total}`;
    if (!vis.length) { list.innerHTML = `<div class="empty">Nothing matches. Clear the search or switch the filter.</div>`; updateProgress(); return; }
    let html = "", group = null;
    const groupSize = {};
    vis.forEach(x => { if (x.group) groupSize[x.group] = (groupSize[x.group] || 0) + 1; });
    for (const it of vis) {
      if (it.group && it.group !== group) {
        group = it.group;
        html += `<div class="group-title"><span class="label">${esc(group)}</span><span class="label num">${groupSize[group]}</span></div>`;
      }
      html += `<article class="item${Store.get(COLL, it.id).read ? " read" : ""}" data-item="${esc(it.id)}">${itemHead(it)}</article>`;
    }
    list.innerHTML = html;
    if (view.open) {
      const el = list.querySelector(`[data-item="${sel(view.open)}"]`);
      if (el) expand(el, false); else view.open = null;
    }
    updateProgress();
  }

  function expand(el, scroll) {
    const it = R.index[el.dataset.item];
    el.classList.add("open");
    el.querySelector("[data-toggle]").setAttribute("aria-expanded", "true");
    let body = el.querySelector(".item-body");
    if (!body) {
      const s = Store.get(COLL, it.id);
      body = document.createElement("div");
      body.className = "item-body";
      body.id = "body-" + it.id;
      body.innerHTML = it.render() + `
        <div class="notes">
          <div class="notes-head"><label class="label" for="note-${esc(it.id)}">Notes</label><span class="save-state" data-save="${esc(it.id)}"></span></div>
          <textarea id="note-${esc(it.id)}" data-note="${esc(it.id)}" rows="3" placeholder="Anything worth remembering…">${esc(s.note || "")}</textarea>
        </div>
        <div class="body-foot">
          <button class="btn ghost" data-collapse="${esc(it.id)}">Close</button>
          <button class="btn" data-done="${esc(it.id)}">${s.read ? "Next unread" : "Mark read · next unread"}</button>
        </div>`;
      el.appendChild(body);
    }
    if (scroll) {
      const bar = app.querySelector(".toolbar");
      const sticky = bar && getComputedStyle(bar).position === "sticky";
      el.style.scrollMarginTop = ((sticky ? bar.offsetHeight : 0) + 8) + "px";
      el.scrollIntoView({ block: "start" });
    }
  }

  function collapse(el) {
    el.classList.remove("open");
    el.querySelector("[data-toggle]").setAttribute("aria-expanded", "false");
    const body = el.querySelector(".item-body");
    if (body) body.remove();
  }

  function toggle(id) {
    const list = app.querySelector("[data-list]");
    const el = list.querySelector(`[data-item="${sel(id)}"]`);
    if (!el) return;
    if (view.open === id) { collapse(el); view.open = null; return; }
    if (view.open) { const prev = list.querySelector(`[data-item="${sel(view.open)}"]`); if (prev) collapse(prev); }
    view.open = id;
    expand(el, true);
  }

  function openNextUnread(afterId) {
    // Walk the whole list in order; search and tier still apply, the read filter doesn't.
    const order = visibleItems("all");
    const i = afterId ? order.findIndex(x => x.id === afterId) : -1;
    const unread = x => !Store.get(COLL, x.id).read;
    const next = order.slice(i + 1).find(unread) || order.slice(0, Math.max(i, 0)).find(unread);
    const list = app.querySelector("[data-list]");
    if (!next) {
      if (view.open) { const el = list.querySelector(`[data-item="${sel(view.open)}"]`); if (el) collapse(el); view.open = null; }
      app.querySelector("[data-count]").textContent = "Everything here is read.";
      return;
    }
    if (!list.querySelector(`[data-item="${sel(next.id)}"]`)) {
      if (view.filter === "read") { view.filter = "all"; syncSeg(); }
      drawList();
    }
    if (view.open !== next.id) toggle(next.id);
  }

  function updateProgress() {
    const total = R.items.length;
    const r = R.items.filter(it => Store.get(COLL, it.id).read).length;
    app.querySelector("[data-read]").textContent = r;
    app.querySelector("[data-bar]").style.width = (total ? (100 * r / total) : 0) + "%";
    app.querySelector("[data-store]").textContent = Store.ok
      ? "Checkmarks and notes are saved in this browser. Use Export and Import to move them to another device."
      : "This browser is blocking storage, so checkmarks and notes won't be kept after you leave.";
  }

  function onStoreChange(coll, id) {
    if (coll !== COLL || !R) return;
    const list = app.querySelector("[data-list]");
    if (!list) return;
    if (!id) { drawList(); return; }
    const el = list.querySelector(`[data-item="${sel(id)}"]`);
    if (el) {
      const s = Store.get(COLL, id);
      el.classList.toggle("read", !!s.read);
      el.querySelector("[data-check]").setAttribute("aria-checked", s.read ? "true" : "false");
      const meta = el.querySelector(".meta");
      const hasNote = !!(s.note && s.note.trim());
      const noteEl = meta.querySelector(".has-note");
      if (hasNote && !noteEl) meta.insertAdjacentHTML("beforeend", `<span class="has-note">✎ Note</span>`);
      if (!hasNote && noteEl) noteEl.remove();
      const done = el.querySelector("[data-done]");
      if (done) done.textContent = s.read ? "Next unread" : "Mark read · next unread";
    }
    updateProgress();
  }

  Vault.gate(app, COLL ? startReader : startHome);
})();
