# Status

Last updated 2026-08-02.

Working notes for picking this up on another machine. Not user documentation —
see [README.md](README.md) for that.

## Where things stand

Live at **https://jharsem.github.io/bl-airgap-lab/**, deployed from `main` on
every push. The deployed build has been checked byte-identical to a local
`npm run build`.

The repo is public and MIT licensed. The optical core is derived from
[Decimen Optical Transfer](https://github.com/bashalarmistalt/decimen-optical-transfer)
(MIT) — see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) for the file-by-file
breakdown. That file is the source of truth on provenance; don't re-derive it by
eye, and don't widen it without comparing against upstream first.

## Open items

**1. Manual browser check of the encryption flow — do this before releasing.**

Nothing has driven encrypt → transmit → scan → unlock through a real browser on
two devices. The crypto and protocol layers are covered by
`tests/crypto.test.mjs`, and the built bundle is confirmed to contain the UI,
but the React wiring between them is untested. Specifically worth confirming:

- Sealing a payload shows "Deriving key…" and completes in reasonable time on a
  phone (PBKDF2 at 600,000 iterations is ~1–2s on mobile — deliberate, but feel
  it before shipping).
- A sealed transfer reaches the receiver as ciphertext and the unlock panel
  appears.
- The correct passphrase opens it; a wrong one reports failure without
  corrupting receiver state.
- A late-joining receiver — start scanning mid-stream — can still open the
  payload. This is the property the per-frame crypto header exists to protect,
  so it is the one most worth testing.

**2. Cut the first release.** Blocked on (1) and on a version decision.
`package.json` says `1.0.0`. Tagging is the whole process:

```bash
git tag v1.0.0 && git push origin v1.0.0
```

`.github/workflows/release.yml` builds, tests, and attaches the single HTML file
plus `SHA256SUMS`, with the digest also written into the release body.

**3. Repo history was squashed to a single root commit on 2026-08-01.** GitHub
retains unreachable objects server-side after a force-push. Deleting and
re-creating the repo, then pushing `main`, is the only way to be certain they
are gone. Cheap to do while there are no stars, forks, or issues; the cost is
losing those if they ever accumulate. See the chat context for detail —
deliberately not restated here.

**4. v2 encryption: hybrid envelope encryption.** The target use case is one
sender broadcasting to a room via a projector or TV.

Seal the payload once under a random content key, then wrap that content key
separately for each recipient and broadcast the small wrapped-key packets
alongside the stream, the way calibration frames already ride along. This gives
both requested modes from one mechanism:

- *Pre-shared*: recipients enrol static public keys ahead of time. Zero
  back-channel — a true one-way blast to a room.
- *Ephemeral*: a receiver displays its public key as a QR for a 1:1 transfer.

The bulk stream is identical either way and does not grow with recipient count.
It also buys per-recipient revocation and sender authentication, neither of
which the v1 shared passphrase can provide.

The v1 header is already compatible: `kdf` is an id, not a hardcoded
assumption, so a v2 key-agreement mode is a new value rather than a redesign.
Note that key packets reveal the recipient count; omitting key ids and having
receivers trial-decrypt is the usual fix if that matters.

## Design decisions already settled

Recorded so they don't get re-litigated:

- **Encrypt-then-fountain.** The payload is sealed once and the fountain codes
  the ciphertext. Sealing per frame would cost a nonce per frame and buy
  nothing.
- **Crypto parameters ride in every sealed frame, not a manifest frame.** A
  manifest would let a late-joining receiver collect a complete ciphertext it
  cannot open, breaking the self-describing property the design rests on. Costs
  32 bytes per sealed frame; unsealed frames keep the original 20-byte header
  and are distinguished by a separate magic byte (`0x0E`).
- **FNV-1a was kept, not replaced with SHA-256.** Without a key, a stronger
  digest in the header would improve corruption detection but not resist
  forgery — an attacker who can display frames just recomputes it. Real
  authenticity comes from the GCM tag. Unencrypted transfers are labelled
  unauthenticated in the UI instead.
- **A failed open reports one outcome.** GCM cannot distinguish a wrong
  passphrase from an altered payload, so the UI does not claim to either.
- **Two distribution paths on purpose.** Pages is for evaluation; the release
  artifact is what anyone who cares about the air gap should use, since loading
  the app over the network on every use defeats the point.
- **`gh release create` rather than a marketplace action**, to keep an unpinned
  third-party action out of the publishing path.

## Environment notes

- Node 22.13+ required. `npm test` runs the build first, so it is the single
  command worth running.
- Camera access needs a secure context. `localhost` counts; another device over
  the LAN needs HTTPS. `npm run dev` provides it via a self-signed cert, which
  the phone must be told to accept.
- Transmitting works from `file://`; receiving does not, because of the secure
  context rule.
- Screenshots could not be automated from this setup — the browser extension
  would not load `localhost` or `file://` URLs, and the devtools bridge needed
  Chrome started with remote debugging. `docs/screenshot.jpg` was captured by
  hand. Budget for that being manual.
- CI logs a Node 20 deprecation warning for `actions/checkout@v4`,
  `setup-node@v4`, `configure-pages@v5`, `upload-artifact@v4`, and
  `deploy-pages@v4`. Harmless — these are current stable versions and GitHub
  forces them onto Node 24. It resolves when the v5s ship.

## Layout

```
app/optical/protocol.ts    frame header, packing, calibration packets, fnv1a, splitmix32
app/optical/fountain.ts    deterministic robust-soliton LT encoder/decoder
app/optical/crypto.ts      AES-256-GCM seal/unseal, PBKDF2, sha256 fingerprints
app/optical/decoder.worker.ts  zxing-wasm QR decode worker
app/page.tsx               transmit/receive UI, calibration sweep, camera loop
tests/                     fountain recovery, sealed round trip, built-artifact shape
.github/workflows/         pages deploy (push to main), release (v* tag)
```
