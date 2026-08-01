import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

test("builds AirGap as one self-contained HTML file", async () => {
  const files = await readdir(new URL("../dist/", import.meta.url));
  assert.deepEqual(files, ["index.html"]);
  const html = await readFile(new URL("../dist/index.html", import.meta.url), "utf8");
  assert.match(html, /<title>AirGap Lab/);
  assert.match(html, /Measure the air gap/);
  assert.match(html, /Transmit/);
  assert.match(html, /Receive/);
  assert.match(html, /data:application\/wasm;base64,/);
  assert.doesNotMatch(html, /<script[^>]+src=/i);
  assert.doesNotMatch(html, /<link[^>]+rel=["']stylesheet["']/i);
  assert.doesNotMatch(html, /react-loading-skeleton/i);
});

test("ships the optical protocol and receiver integrity checks", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const protocol = await readFile(new URL("../app/optical/protocol.ts", import.meta.url), "utf8");
  const fountain = await readFile(new URL("../app/optical/fountain.ts", import.meta.url), "utf8");
  const worker = await readFile(new URL("../app/optical/decoder.worker.ts", import.meta.url), "utf8");
  assert.match(protocol, /HEADER_LEN = 20/);
  assert.match(protocol, /packCalibrationControl/);
  assert.match(protocol, /parseCalibrationPacket/);
  assert.match(page, /Unreadable profiles are recorded as zero/);
  assert.match(page, /SWEEP_PROFILES/);
  assert.match(page, /Run calibration sweep/);
  assert.match(page, /Calibration results/);
  assert.match(page, /calibrationLocked/);
  assert.match(page, /Best setting for this setup/);
  assert.match(page, /Start data receiver/);
  assert.match(page, /new LTEncoder/);
  assert.match(page, /new LTDecoder/);
  assert.match(fountain, /solitonCdf/);
  assert.match(fountain, /private resolve/);
  assert.match(page, /getUserMedia/);
  assert.match(page, /facingMode/);
  assert.match(page, /frameRate: \{ exact: 60 \}/);
  assert.match(page, /requestVideoFrameCallback/);
  assert.match(page, /decoder\.worker\?worker&inline/);
  assert.match(worker, /readBarcodes/);
  assert.match(worker, /formats: \["QRCode"\]/);
  assert.match(page, /maskPattern: 4/);
  assert.match(page, /requestAnimationFrame/);
  assert.match(page, /Download received file/);
});
