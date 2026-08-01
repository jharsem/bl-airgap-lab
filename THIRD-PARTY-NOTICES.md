# Third-party notices

## Decimen Optical Transfer

Portions of AirGap Lab's optical transfer core are derived from
[Decimen Optical Transfer](https://github.com/bashalarmistalt/decimen-optical-transfer)
by BashAlarmist, used under the MIT License.

Specifically, `app/optical/fountain.ts` and `app/optical/protocol.ts` are
adapted from that project's `shared/fountain.ts` and `shared/protocol.ts`. The
derived material includes:

- The deterministic robust-soliton LT fountain construction, including the
  `SOLITON_C` / `SOLITON_DELTA` parameters and the peeling decoder.
- The cross-engine-deterministic natural logarithm (exact-IEEE-754 range
  reduction plus a 21-term atanh series), which exists to keep sender and
  receiver degree distributions bit-identical across V8 and JavaScriptCore.
- The `splitmix32` PRNG and its constants.
- The self-describing 20-byte frame header layout and its `0xD1 0x0C` magic
  bytes.

AirGap Lab extends this base with a calibration-sweep packet type, additional
receiver integrity checks, and a single-file build. Those additions do not
change the provenance of the material above.

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
