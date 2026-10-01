// Encrypts the site's content so it can be published on GitHub Pages behind a password.
//
//   SITE_PASSWORD='…' node tools/encrypt.mjs                  encrypt private/*.json -> data/*.enc
//   SITE_PASSWORD='…' node tools/encrypt.mjs --decrypt        restore private/*.json from data/*.enc
//   SITE_PASSWORD='old' NEW_SITE_PASSWORD='new' node tools/encrypt.mjs --change-password
//   SITE_PASSWORD='…' node tools/encrypt.mjs --set-link <id> "<title>" "<blurb>" https://…
//
// Scheme: a random 256-bit content key (DEK) encrypts every file with AES-256-GCM
// (gzip first, file name as associated data, fresh random IV each time). The DEK is stored in
// data/key.json, wrapped with a key derived from the password (PBKDF2-SHA256, 600k iterations),
// together with a random key id the pages use to notice a key change.
// --change-password also replaces the DEK and re-encrypts everything, so browsers that stayed
// unlocked with the old password must unlock again. Old ciphertext stays in git history, so a
// password change only protects what is published after it.
// Plaintext lives only in private/, which is git-ignored.
import { webcrypto as crypto } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const PRIVATE = path.join(root, "private");
const DATA = path.join(root, "data");
const KEY_FILE = path.join(DATA, "key.json");
const ITER = 600_000;
const MIN_PASSWORD = 16;
const b64 = u8 => Buffer.from(u8).toString("base64");
const unb64 = s => new Uint8Array(Buffer.from(s, "base64"));
const fail = msg => { console.error(msg); process.exit(1); };

function writeAtomic(file, data) {
  const tmp = file + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

async function kek(password, salt, iter, usage) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(password.normalize("NFC")), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations: iter }, base, { name: "AES-GCM", length: 256 }, false, usage);
}

async function wrap(dek, password) {
  if (password.length < MIN_PASSWORD) fail(`Use a password of at least ${MIN_PASSWORD} characters (a few random words works well).`);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const k = await kek(password, salt, ITER, ["encrypt"]);
  const wrapped = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, k, dek));
  const kid = Buffer.from(crypto.getRandomValues(new Uint8Array(8))).toString("hex");
  return JSON.stringify({ v: 1, kid, kdf: "PBKDF2-SHA256", iter: ITER, salt: b64(salt), iv: b64(iv), wrapped: b64(wrapped) }, null, 1) + "\n";
}

async function unwrap(meta, password) {
  const k = await kek(password, unb64(meta.salt), meta.iter, ["decrypt"]);
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(meta.iv) }, k, unb64(meta.wrapped)));
  } catch {
    fail("Wrong password for the existing data/key.json");
  }
}

const encFiles = () => fs.existsSync(DATA) ? fs.readdirSync(DATA).filter(f => f.endsWith(".enc")).sort() : [];
const importDek = dek => crypto.subtle.importKey("raw", dek, "AES-GCM", false, ["encrypt", "decrypt"]);

async function decryptFile(k, name) {
  const buf = new Uint8Array(fs.readFileSync(path.join(DATA, name + ".enc")));
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: buf.slice(0, 12), additionalData: new TextEncoder().encode(name) }, k, buf.slice(12));
  return gunzipSync(Buffer.from(plain));
}

async function encryptBytes(k, name, json) {
  const plain = gzipSync(json, { level: 9 });
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(name) }, k, plain));
  return Buffer.concat([Buffer.from(iv), Buffer.from(ct)]);
}

const password = process.env.SITE_PASSWORD;
if (!password) fail("Set SITE_PASSWORD");

let dek;
if (fs.existsSync(KEY_FILE)) {
  dek = await unwrap(JSON.parse(fs.readFileSync(KEY_FILE, "utf8")), password);
} else {
  if (encFiles().length) fail("data/*.enc exists but data/key.json is missing; refusing to create a new key over it.");
  dek = crypto.getRandomValues(new Uint8Array(32));
  fs.mkdirSync(DATA, { recursive: true });
  writeAtomic(KEY_FILE, await wrap(dek, password));
  console.log("created data/key.json");
}
const key = await importDek(dek);

if (process.argv.includes("--decrypt")) {
  fs.mkdirSync(PRIVATE, { recursive: true });
  for (const f of encFiles()) {
    const name = f.replace(/\.enc$/, "");
    writeAtomic(path.join(PRIVATE, name + ".json"), await decryptFile(key, name));
    console.log(`private/${name}.json`);
  }
  process.exit(0);
}

if (process.argv.includes("--change-password")) {
  const next = process.env.NEW_SITE_PASSWORD;
  if (!next) fail("Set NEW_SITE_PASSWORD");
  const newDek = crypto.getRandomValues(new Uint8Array(32));
  const newKey = await importDek(newDek);
  const keyJson = await wrap(newDek, next);                    // slow step first, before touching files
  const staged = [];
  for (const f of encFiles()) {
    const name = f.replace(/\.enc$/, "");
    const tmp = path.join(DATA, `${name}.enc.new-${process.pid}`);
    fs.writeFileSync(tmp, await encryptBytes(newKey, name, await decryptFile(key, name)));
    staged.push([tmp, path.join(DATA, f)]);
  }
  // If this is interrupted, data/key.json.new wraps the content key of any already-renamed files.
  fs.writeFileSync(KEY_FILE + ".new", keyJson);
  for (const [tmp, dest] of staged) fs.renameSync(tmp, dest);
  fs.renameSync(KEY_FILE + ".new", KEY_FILE);
  console.log("password changed and content key replaced; browsers that stayed unlocked must unlock again");
  process.exit(0);
}

// Add or update a home-page card that links to an outside app, straight in data/manifest.enc
// (no plaintext written). Also updates private/manifest.json when it exists, so a later full
// encrypt from private/ keeps the card.
const linkAt = process.argv.indexOf("--set-link");
if (linkAt !== -1) {
  const [id, title, blurb, url] = process.argv.slice(linkAt + 1);
  if (!/^[a-z0-9-]+$/.test(id || "") || !title || !blurb || !/^https:\/\/\S+$/.test(url || ""))
    fail('Usage: node tools/encrypt.mjs --set-link <id> "<title>" "<blurb>" https://…');
  const entry = { id, title, blurb, url };
  const upsert = m => {
    const i = m.collections.findIndex(c => c.id === id);
    if (i === -1) m.collections.push(entry); else m.collections[i] = entry;
    return m;
  };
  const manifest = upsert(JSON.parse(await decryptFile(key, "manifest")));
  writeAtomic(path.join(DATA, "manifest.enc"), await encryptBytes(key, "manifest", JSON.stringify(manifest)));
  const priv = path.join(PRIVATE, "manifest.json");
  if (fs.existsSync(priv)) writeAtomic(priv, JSON.stringify(upsert(JSON.parse(fs.readFileSync(priv, "utf8"))), null, 1) + "\n");
  console.log("home page cards: " + manifest.collections.map(c => c.title).join(", "));
  process.exit(0);
}

const files = fs.existsSync(PRIVATE) ? fs.readdirSync(PRIVATE).filter(f => f.endsWith(".json")).sort() : [];
if (!files.length) fail("Nothing to encrypt in private/ (run with --decrypt first to restore it).");
for (const f of files) {
  const name = f.replace(/\.json$/, "");
  const out = await encryptBytes(key, name, fs.readFileSync(path.join(PRIVATE, f)));
  writeAtomic(path.join(DATA, name + ".enc"), out);
  console.log(`data/${name}.enc  ${out.length.toLocaleString()} bytes`);
}
