# Third-party notices

## Decimen Optical Transfer

Portions of AirGap Lab's optical transfer core are derived from
[Decimen Optical Transfer](https://github.com/bashalarmistalt/decimen-optical-transfer)
by BashAlarmist, used under the MIT License.

### `app/optical/fountain.ts` — from `shared/fountain.ts`

- The deterministic robust-soliton LT fountain construction, including the
  `SOLITON_C` / `SOLITON_DELTA` parameters and the peeling decoder.
- The cross-engine-deterministic natural logarithm (exact-IEEE-754 range
  reduction plus a 21-term atanh series), which exists to keep sender and
  receiver degree distributions bit-identical across V8 and JavaScriptCore.

### `app/optical/protocol.ts` — from `shared/protocol.ts`

- The `splitmix32` PRNG and its constants.
- The `fnv1a` payload checksum.
- The self-describing 20-byte frame header layout and its `0xD1 0x0C` magic
  bytes.

### `app/optical/decoder.worker.ts` — from `receive/worker.ts`

- The zxing-wasm worker structure: the `locateFile` override for the bundled
  `.wasm`, single-symbol `readBarcodes` configuration, the
  `isValid && bytes.length > 0` result filter, and the 8×8 `ImageData`
  warm-up decode that reports readiness under sentinel id `-1`.

### `app/page.tsx` — from `send/main.ts` and `receive/main.ts`

A React rewrite, but the transport mechanics are adapted:

- Sender frame pacing and the staging-canvas render path
  (`putImageData` → `imageSmoothingEnabled = false` → scaled `drawImage`).
- The fixed `maskPattern: 4` QR encoding choice.
- Receiver camera acquisition, including the nested `getUserMedia` retry that
  falls back from an exact to an ideal frame rate.
- The `requestVideoFrameCallback` capture loop and its typed shim, and the
  `willReadFrequently` grab canvas.
- Payload verification by comparing `fnv1a` against the header checksum.

## Not derived

`app/globals.css`, `src/main.tsx`, `index.html`, the build configuration, and
the test suite are AirGap Lab's own work. AirGap Lab also adds a
calibration-sweep packet type and control flow, DPI-aware integer frame
scaling, a synthetic payload generator, and a single-file build. Those
additions do not change the provenance of the material above.

### License

    MIT License

    Copyright (c) 2026 BashAlarmist

    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in all
    copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
    SOFTWARE.
