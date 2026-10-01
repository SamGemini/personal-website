# personal-website

A password-protected reading desk, published with GitHub Pages at
https://samgemini.github.io/personal-website/

- `index.html`: home page (links to each reader)
- `bluetorch/`, `moneystuff/`: reader pages. Each section can be checked off and has a notes box.
  Checkmarks and notes are saved in the browser. On https://samgemini.fly.dev/ (which mirrors this
  site) they also sync across devices: the browser derives a sync key and a server-side id from the
  content key (`vault.js`) and keeps one AES-GCM-encrypted copy on the server via `/api/desk-sync/:id`,
  so the server never sees them. Each item's newest change wins. On GitHub Pages there is no sync API,
  so progress stays in the browser and Export/Import moves it between devices.
- `assets/`: shared CSS and JS. `vault.js` handles the password and decryption.
- `data/*.enc`: the content, encrypted with AES-256-GCM. `data/key.json` holds the content key,
  wrapped with a key derived from the password (PBKDF2-SHA256, 600,000 iterations).
  Nothing readable is committed; plaintext lives only in the git-ignored `private/` folder.
- Anyone can download the encrypted files, so the protection is only as strong as the password.
  Use a long random passphrase (the tool refuses anything under 16 characters).
- "Stay unlocked on this device" keeps the content key in the browser (IndexedDB, as a
  non-extractable key) until Lock is pressed. Checkmarks and notes stay in the browser after Lock.

## Adding or rebuilding content

```sh
SITE_PASSWORD='…' node tools/encrypt.mjs --decrypt     # restore private/*.json from data/*.enc
python3 tools/parse_bluetorch.py "Blue Torch Deal Book.pdf" /tmp/bluetorch.json
python3 tools/parse_moneystuff.py "Money Stuff.pdf" /tmp/moneystuff.json --headings private/moneystuff-headings.json
python3 tools/pack.py /tmp/bluetorch.json /tmp/moneystuff.json private
SITE_PASSWORD='…' node tools/encrypt.mjs               # private/*.json -> data/*.enc
```

A new collection needs its JSON in `private/`, an entry in `private/manifest.json`, a page folder
like `bluetorch/`, and a matching branch in `assets/reader.js`.

## Links to outside apps

A home-page card can link to another site instead of a reader page (e.g. Leer, the reading
app hosted on Fly.io). The card lives in the encrypted manifest, so the address is only visible
after unlocking:

```sh
SITE_PASSWORD='…' node tools/encrypt.mjs --set-link leer "Leer" "Spanish reading practice" https://leer-9b19de37.fly.dev/
```

Running it again with the same id updates the card. It also updates `private/manifest.json` when
that folder is present, so a later full encrypt keeps the card.

## Changing the password

```sh
SITE_PASSWORD='old' NEW_SITE_PASSWORD='new' node tools/encrypt.mjs --change-password
```

This also replaces the content key, so browsers that stayed unlocked have to enter the new
password. Earlier encrypted files remain in the public git history, so a password change only
protects content published after it: anyone who had the old password can still decrypt the old
snapshot from history.
