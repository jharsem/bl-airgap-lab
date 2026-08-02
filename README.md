# AirGap Lab

AirGap Lab measures and demonstrates one-way file transfer through animated QR
codes. One device displays an endless fountain-coded stream while another uses
its camera to reconstruct and verify the original bytes.

The application is local-first. It has no account system, backend, analytics,
database, cloud API, or network transfer path for the payload.

<p align="center">
  <img src="docs/screenshot.jpg" width="820"
       alt="AirGap Lab transmit view: a 64 kB synthetic payload streaming as fountain-coded QR frames, with payload and device-calibration controls alongside" />
</p>

## Run locally

Requirements: Node.js 22.13 or newer.

```bash
npm install
npm run dev
```

Vite prints local and network HTTPS addresses. Open the local address on the
sending device. For an iPhone receiver, open the network address, accept the
self-signed development certificate, select **Receive**, and allow camera
access.

The page must be in a secure browser context for camera access. `localhost` is
treated as secure; another device connecting over the LAN needs HTTPS.

## Build one portable HTML file

```bash
npm run build
```

The result is `dist/index.html`. It contains the application JavaScript, CSS,
QR encoder, decoder worker, and ZXing WebAssembly binary—there are no companion
runtime files or CDN dependencies.

You can open the file directly for transmitting. Browser security normally
blocks camera access from `file://`, so receiving should use an HTTPS server:

```bash
npm run preview
```

The single HTML file can also be copied to any static HTTPS web server.

## Get it

Each release attaches that single file, with its SHA-256 in the release notes.
For an air-gapped machine this is the file to carry across — verify it first:

```bash
shasum -a 256 airgap-lab-v1.0.0.html
```

The hosted build at
[jharsem.github.io/bl-airgap-lab](https://jharsem.github.io/bl-airgap-lab/) is
for trying it out. If you actually care about the air gap, use the downloaded
file rather than loading the app over the network each time.

## Test

```bash
npm test
```

Tests verify the standalone artifact shape, protocol features, recovery of a
payload with simulated dropped and duplicate fountain frames, and the sealed
round trip — including that a wrong passphrase and a tampered payload both fail
closed. Malformed frame dimensions and unsafe KDF costs are rejected before
they can consume receiver resources.

## Optical pipeline

- Raw binary QR byte mode with a compact 20-byte frame header
- Deterministic robust-soliton LT fountain coding
- ZXing C++/WebAssembly decoding in two inline workers
- Camera delivery driven by `requestVideoFrameCallback` when available
- Fixed QR mask, integer scaling, and queued sender frames
- Calibration sweep from conservative to maximum-density profiles
- Optional AES-256-GCM sealing, applied before fountain coding
- Reconstructed-byte verification before download
- Production Content Security Policy permits only inline data/blob resources
  and blocks network connections

AirGap Lab does not create a radio or network data channel between sender and
receiver. A network connection may be used only to load the page; the selected
payload itself travels through the screen and camera.

## Encryption

Enter a passphrase on the transmitter and press **Encrypt payload**. The
receiver needs the same phrase to open the transfer.

- **AES-256-GCM**, with the key derived by PBKDF2-SHA256 at 600,000 iterations.
  The salt, nonce, and iteration count travel in every sealed frame, so a
  receiver that joins the stream late can still open the payload.
- **Encrypt-then-fountain.** The payload is sealed once and the fountain codes
  the ciphertext, so frames stay interchangeable and the stream stays rateless.
- Everything uses WebCrypto — no dependencies, and it works offline.

Because the passphrase is a shared secret, one sender can broadcast to a room
of receivers who all hold the same phrase. Share it out of band; speaking it
aloud is fine, sending it over the channel you are trying to protect is not.

### What this does and does not protect

An **unencrypted** transfer is readable by anyone with a view of the screen,
and it is *not authenticated*. The FNV-1a value in the frame header is a
reassembly check, not a security property: it is keyless, so anyone able to put
frames in front of the camera can substitute a payload and recompute it. The
receiver labels these transfers as unauthenticated and shows a SHA-256 digest
so you can compare it against one obtained out of band.

An **encrypted** transfer is confidential and authenticated — the GCM tag means
a payload that opens is exactly what the sender sealed. A failed open reports
one outcome, not two: GCM cannot distinguish a wrong passphrase from an altered
payload, so neither does the UI.

Neither mode protects against a compromised sender or receiver, and neither
hides metadata. Payload size, transfer duration, and the fact that a transfer
is happening at all remain visible to anyone watching the screen.

Passphrases inherit every shared-secret weakness: no per-recipient revocation,
no sender authentication, and a recording of the screen stays decryptable by
anyone who ever learned the phrase.

## Acknowledgements

The fountain-coding core of this project is adapted from
[Decimen Optical Transfer](https://github.com/bashalarmistalt/decimen-optical-transfer)
by BashAlarmist, used under the MIT License. Thank you.

That project worked out a materially better approach to the speed-limiting part
of an optical link than we had: a deterministic robust-soliton LT construction
where the degree distribution is reproducible bit-for-bit across JavaScript
engines. That determinism is what lets the sender fire frames blind at full
rate, with no handshake, no back-channel, and no retransmission — a dropped
frame costs a little time rather than correctness. It is the difference between
a demo and something that actually sustains throughput.

The optical layer in `app/optical/` is derived from that work. A file-by-file
breakdown and the upstream license are in
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
