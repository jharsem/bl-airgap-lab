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

**1. ~~Manual browser check of the encryption flow.~~ Done — app tested by hand
and working.** One caveat worth recording: it is not confirmed that the
late-joining receiver case was exercised specifically — starting a scan
mid-stream and still opening the payload. That is the property the per-frame
crypto header exists to protect, so if it has not been driven end to end, it is
still the check most worth doing.

**2. ~~Cut the first release.~~ Done — `v1.0.0` tagged and published
2026-08-02.** Release workflow succeeded; `airgap-lab-v1.0.0.html` (1,712,626
bytes) and `SHA256SUMS` are attached at
<https://github.com/jharsem/bl-airgap-lab/releases/tag/v1.0.0>. The published
digest `47dc822e15e7ab86eaca226878dfbb6ed60dc47afc52ed7a82edfb7dd380fe90`
matches a local `npm run build` byte for byte, so the build is reproducible
across machines. Next release is the same one-liner:

```bash
git tag v1.0.1 && git push origin v1.0.1
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
- **The bundle contains a jsdelivr URL string; it is dead code.** Grepping the
  artifact turns up
  `https://fastly.jsdelivr.net/npm/zxing-wasm@3.1.2/...` — zxing-wasm's default
  CDN fallback for locating its `.wasm`. It is never reached:
  `decoder.worker.ts` overrides `locateFile` to return the bundled asset, and
  `assetsInlineLimit: () => true` inlines that as a `data:application/wasm`
  URI. Verified present in the built file. Expect this to be re-flagged by
  anyone auditing the artifact for network paths — the answer is the override,
  not a rebuild.

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
