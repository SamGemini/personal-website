// Password gate and decryption for the reading pages.
// Content is AES-256-GCM encrypted (see tools/encrypt.mjs); the password unwraps the content key.
// An unlocked key is kept as a non-extractable CryptoKey in IndexedDB: pages on this origin can use
// it, but nothing can read the key bytes back out.
(() => {
  const ROOT = document.documentElement.dataset.root || "./";
  const DB_NAME = "reading-desk", STORE = "keys", REC = "content";
  const SESSION_FLAG = "reading-desk:session";
  const enc = new TextEncoder();
  const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const channel = "BroadcastChannel" in window ? new BroadcastChannel("reading-desk") : null;
  const escText = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // ---------------------------------------------------------------- key storage (IndexedDB)
  function idb() {
    return new Promise((resolve, reject) => {
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  async function tx(mode, fn) {
    const db = await idb();
    return new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const req = fn(t.objectStore(STORE));
      t.oncomplete = () => { db.close(); resolve(req && req.result); };
      t.onerror = t.onabort = () => { db.close(); reject(t.error); };
    });
  }
  const SESSION_TTL = 12 * 3600 * 1000;   // session-only keys left behind by closed tabs are purged after this
  const getRecord = id => tx("readonly", s => s.get(id)).catch(() => null);
  const allIds = () => tx("readonly", s => s.getAllKeys()).catch(() => []);
  const sessionFlag = () => { try { return sessionStorage.getItem(SESSION_FLAG); } catch (e) { return null; } };
  async function forget() {
    try {
      const ids = await allIds();
      await tx("readwrite", s => { ids.forEach(id => s.delete(id)); });
    } catch (e) {}
    try { sessionStorage.removeItem(SESSION_FLAG); } catch (e) {}
  }
  async function remember(key, sync, kid, persist) {
    let id = REC;
    if (!persist) {
      const token = Array.from(crypto.getRandomValues(new Uint8Array(8)), b => b.toString(16).padStart(2, "0")).join("");
      try { sessionStorage.setItem(SESSION_FLAG, token); } catch (e) { return; }
      id = "session:" + token;
    }
    try { await tx("readwrite", s => s.put({ key, sync, kid, at: Date.now() }, id)); } catch (e) { /* stays unlocked for this page only */ }
  }
  async function savedKey(kid) {
    // Purge session-only keys from browser sessions that have ended.
    const ids = await allIds();
    const now = Date.now();
    for (const id of ids) {
      if (typeof id !== "string" || !id.startsWith("session:")) continue;
      const rec = await getRecord(id);
      if (!rec || now - (rec.at || 0) > SESSION_TTL) await tx("readwrite", s => s.delete(id)).catch(() => {});
    }
    const flag = sessionFlag();
    for (const id of [flag ? "session:" + flag : null, REC]) {
      if (!id) continue;
      const rec = await getRecord(id);
      if (!rec) continue;
      if (rec.key instanceof CryptoKey && rec.sync && rec.sync.key instanceof CryptoKey && rec.kid === kid) return rec;
      await tx("readwrite", s => s.delete(id)).catch(() => {});   // stale (password changed), malformed, or saved before sync existed
    }
    return null;
  }

  // ---------------------------------------------------------------- crypto
  async function fetchMeta() {
    const res = await fetch(ROOT + "data/key.json", { cache: "no-cache" });
    if (!res.ok) throw new Error("The site's key file is missing (HTTP " + res.status + ").");
    return res.json();
  }

  async function unlock(meta, password) {
    const base = await crypto.subtle.importKey("raw", enc.encode(password.normalize("NFC")), "PBKDF2", false, ["deriveKey"]);
    const kek = await crypto.subtle.deriveKey(
      { name: "PBKDF2", hash: "SHA-256", salt: unb64(meta.salt), iterations: meta.iter },
      base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
    let raw;
    try {
      raw = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(meta.iv) }, kek, unb64(meta.wrapped)));
    } catch (e) {
      const err = new Error("That password isn't right. Check it and try again.");
      err.wrongPassword = true;
      throw err;
    }
    const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
    const sync = await syncKeys(raw);
    raw.fill(0);
    return { key, sync };
  }

  // Progress sync (reader.js): a separate key plus a server-side id, both derived from the content key,
  // so the server stores only ciphertext and only someone with the password can find or read it.
  async function syncKeys(raw) {
    const base = await crypto.subtle.importKey("raw", raw, "HKDF", false, ["deriveKey", "deriveBits"]);
    const p = info => ({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: enc.encode("reading-desk " + info) });
    const key = await crypto.subtle.deriveKey(p("sync key v1"), base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    const bits = new Uint8Array(await crypto.subtle.deriveBits(p("sync id v1"), base, 256));
    return { key, id: Array.from(bits, b => b.toString(16).padStart(2, "0")).join("") };
  }

  function loader(key, kid) {
    return async name => {
      const res = await fetch(ROOT + "data/" + name + ".enc?k=" + encodeURIComponent(kid), { cache: "no-cache" });
      if (!res.ok) throw new Error("Couldn't download " + name + " (HTTP " + res.status + ").");
      const buf = new Uint8Array(await res.arrayBuffer());
      let plain;
      try {
        plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: buf.slice(0, 12), additionalData: enc.encode(name) }, key, buf.slice(12));
      } catch (e) {
        const err = new Error("Couldn't decrypt " + name + ".");
        err.badKey = true;
        throw err;
      }
      const text = await new Response(new Blob([plain]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
      return JSON.parse(text);
    };
  }

  // ---------------------------------------------------------------- UI
  function formHtml(msg) {
    return `<div class="gate">
      <h1>Reading Desk</h1>
      <p>This site is private. Enter the password to continue.</p>
      <form autocomplete="on">
        <input class="visually-hidden" type="text" name="username" autocomplete="username" value="reading-desk" tabindex="-1" aria-hidden="true">
        <label class="visually-hidden" for="pw">Password</label>
        <input id="pw" name="password" type="password" autocomplete="current-password" placeholder="Password" required>
        <label class="remember"><input id="remember" type="checkbox" checked> Stay unlocked on this device until I press Lock</label>
        <button class="btn" type="submit">Unlock</button>
        <div class="err" role="alert">${escText(msg)}</div>
      </form>
    </div>`;
  }

  function errorScreen(mount, start, message) {
    mount.innerHTML = `<div class="gate"><h1>Reading Desk</h1>
      <p class="err">${escText(message)}</p>
      <div style="display:flex;gap:.5rem;flex-wrap:wrap">
        <button class="btn" data-retry>Try again</button>
        <button class="btn ghost" data-relock>Enter the password again</button>
      </div></div>`;
    mount.querySelector("[data-retry]").addEventListener("click", () => location.reload());
    mount.querySelector("[data-relock]").addEventListener("click", async () => { await forget(); showForm(mount, start); });
  }

  function showForm(mount, start, meta, msg) {
    mount.innerHTML = formHtml(msg);
    const form = mount.querySelector("form");
    const pw = mount.querySelector("#pw");
    const btn = mount.querySelector("button[type=submit]");
    const err = mount.querySelector(".err");
    pw.focus();
    form.addEventListener("submit", async e => {
      e.preventDefault();
      btn.disabled = true; btn.textContent = "Unlocking…"; err.textContent = "";
      try {
        meta = meta || await fetchMeta();
        const { key, sync } = await unlock(meta, pw.value);
        const persist = mount.querySelector("#remember").checked;
        await start(key, loader(key, meta.kid), sync);
        await remember(key, sync, meta.kid, persist);
        if (channel) channel.postMessage("unlock");
      } catch (ex) {
        if (!mount.contains(form)) { errorScreen(mount, start, ex.message || String(ex)); return; }
        btn.disabled = false; btn.textContent = "Unlock";
        err.textContent = ex.message || "Something went wrong. Try again.";
        if (ex.wrongPassword) pw.select();
      }
    });
  }

  // Shows the gate until a working key is available, then calls start(key, load, sync).
  async function gate(mount, start) {
    if (!(window.crypto && crypto.subtle && window.DecompressionStream && window.indexedDB)) {
      mount.innerHTML = `<div class="gate"><h1>Reading Desk</h1><p>This browser can't open the site. Use a current version of Chrome, Safari, Firefox or Edge.</p></div>`;
      return;
    }
    let meta;
    try { meta = await fetchMeta(); }
    catch (e) { errorScreen(mount, start, (e.message || String(e)) + " Check your connection."); return; }
    const rec = await savedKey(meta.kid);
    if (!rec) { showForm(mount, start, meta); return; }
    try {
      await start(rec.key, loader(rec.key, meta.kid), rec.sync);
    } catch (e) {
      if (e.badKey) { await forget(); showForm(mount, start, meta); return; }
      errorScreen(mount, start, e.message || String(e));
    }
  }

  async function lock() {
    await forget();
    if (channel) channel.postMessage("lock");
    document.getElementById("app").innerHTML = "";
    location.reload();
  }

  // Locking in one tab locks the others; unlocking in one tab unlocks tabs sitting at the password form.
  if (channel) channel.onmessage = e => {
    if (e.data === "lock") { document.getElementById("app").innerHTML = ""; location.reload(); }
    if (e.data === "unlock" && document.querySelector(".gate form")) location.reload();
  };
  // A page restored from the back/forward cache after Lock must not show decrypted content.
  window.addEventListener("pageshow", async e => {
    if (!e.persisted) return;
    const flag = sessionFlag();
    const rec = (flag && await getRecord("session:" + flag)) || await getRecord(REC);
    if (!rec) { document.getElementById("app").innerHTML = ""; location.reload(); }
  });

  window.Vault = { gate, lock };
})();
