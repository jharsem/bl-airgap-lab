# Status

Last updated 2026-08-02, after tagging v1.0.0.

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

**1. ~~Manual browser check of the encryption flow.~~ Done — driven by hand in
a real browser on 2026-08-02, including the late-joining receiver.** Starting a
scan mid-stream and still opening the payload works, which is the property the
per-frame crypto header exists to protect and the one the design most depended
on. Encrypt → transmit → scan → unlock is confirmed end to end.

**2. ~~Cut the first release.~~ Done — `v1.0.0` tagged and published
2026-08-02**, `v1.0.1` the same day once the CDN fallback was stripped. Assets
are the single HTML file plus `SHA256SUMS` at
<https://github.com/jharsem/bl-airgap-lab/releases>. The v1.0.0 digest
`47dc822e15e7ab86eaca226878dfbb6ed60dc47afc52ed7a82edfb7dd380fe90` matched a
local `npm run build` byte for byte, so the build reproduces across machines —
worth re-checking on future releases, since it is the property that lets anyone
verify the download independently. Releasing is one line:

```bash
git tag v1.0.2 && git push origin v1.0.2
```

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
- **The artifact carries no external URL, and a test enforces it.**
  zxing-wasm's default `locateFile` resolved its `.wasm` against a jsDelivr
  CDN. That branch was already unreachable — `decoder.worker.ts` overrides
  `locateFile`, and the override replaces the default rather than merging with
  it — but an unreachable CDN URL still fails *open* if a later change drops
  the override. The `strip-zxing-cdn-fallback` plugin in `vite.config.ts`
  rewrites it to a relative path that cannot resolve, so that mistake fails
  closed instead. Note it is registered twice, under `plugins` and
  `worker.plugins`: Vite bundles workers in a separate Rollup pass that does
  not inherit `plugins`, and zxing-wasm is reached only from the worker, so the
  `plugins` entry alone silently did nothing.

  The plugin is the fix; the `ships no network path` test is the guarantee. It
  fails on any URL in the built file outside an allowlist of `www.w3.org`
  (namespace identifiers in SVG/MathML, never fetched) and `react.dev` (a
  documentation pointer in React's minified error messages). A zxing-wasm
  upgrade that moves the URL out of the plugin's reach breaks that test rather
  than quietly restoring a CDN reference.

  **The published v1.0.0 asset predates this** and still contains the jsdelivr
  string. Harmless for the reason above, but anyone auditing that specific
  download will find it.

## Environment notes

- Node 22.13+ required. `npm test` runs the build first, so it is the single
  command worth running.
- `npm audit` was clean as of v1.0.0 (vite pinned to 8.2.0). The advisories
  cleared at that bump were all dev-toolchain and none reached the artifact,
  but the rule going forward is that a release lockfile should not ship known
  vulnerable versions.
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
