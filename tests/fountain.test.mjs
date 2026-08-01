import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";

test("LT fountain frames recover a payload after shuffled losses", async () => {
  const vite = await createServer({ appType: "custom", configFile: false, logLevel: "silent", server: { middlewareMode: true } });
  try {
    const { LTDecoder, LTEncoder } = await vite.ssrLoadModule("/app/optical/fountain.ts");
    const payload = new Uint8Array(48_731);
    for (let index = 0; index < payload.length; index += 1) payload[index] = (index * 37 + index ** 2) & 0xff;
    const blockLen = 980;
    const sessionId = 42_517;
    const encoder = new LTEncoder(payload, blockLen, sessionId);
    const decoder = new LTDecoder(encoder.k, blockLen, sessionId, payload.length);

    // Simulate a camera missing roughly one frame in five and seeing duplicates.
    for (let sequence = 0; sequence < encoder.k * 4 && !decoder.isComplete; sequence += 1) {
      if (sequence % 5 === 2) continue;
      const block = encoder.encode(sequence);
      decoder.addFrame(sequence, block);
      if (sequence % 13 === 0) decoder.addFrame(sequence, block);
    }

    assert.equal(decoder.isComplete, true);
    assert.deepEqual(decoder.assemble(), payload);
    assert.ok(decoder.framesDup > 0);
  } finally {
    await vite.close();
  }
});
