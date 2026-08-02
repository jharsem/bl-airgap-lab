import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";

async function loadProtocol() {
  const vite = await createServer({ appType: "custom", configFile: false, logLevel: "silent", server: { middlewareMode: true } });
  return { protocol: await vite.ssrLoadModule("/app/optical/protocol.ts"), close: () => vite.close() };
}

function rawFrame({ k = 1, blockLen = 1, totalLen = 1, sealed = false, iterations = 600_000 } = {}) {
  const headerLen = sealed ? 52 : 20;
  const bytes = new Uint8Array(headerLen + blockLen);
  const view = new DataView(bytes.buffer);
  bytes[0] = 0xd1; bytes[1] = sealed ? 0x0e : 0x0c;
  view.setUint16(2, 1, true); view.setUint32(4, 1, true);
  view.setUint16(8, k, true); view.setUint16(10, blockLen, true);
  view.setUint32(12, totalLen, true); view.setUint32(16, 123, true);
  if (sealed) {
    bytes[20] = 1;
    view.setUint16(22, iterations / 1000, true);
  }
  return bytes;
}

test("rejects frame dimensions that could exhaust receiver resources", async () => {
  const { protocol, close } = await loadProtocol();
  try {
    assert.equal(protocol.parseFrame(rawFrame({ totalLen: 0xffff_ffff })), null);
    assert.equal(protocol.parseFrame(rawFrame({ k: 2, totalLen: 1 })), null);
    assert.equal(protocol.parseFrame(rawFrame({ blockLen: protocol.MAX_BLOCK_LEN + 1 })), null);
    assert.equal(protocol.parseFrame(rawFrame({ sealed: true, iterations: 65_000_000 })), null);
    assert.equal(protocol.maxPayloadForBlock(400), 400 * 0xffff);
    assert.equal(protocol.maxPayloadForBlock(protocol.MAX_BLOCK_LEN + 1), 0);
    assert.throws(() => protocol.packFrame({
      sessionId: 1, seq: 1, k: 1, blockLen: 1,
      totalLen: 0xffff_ffff, payloadFnv: 123,
    }, new Uint8Array(1)), /Invalid frame dimensions/);
  } finally {
    await close();
  }
});

test("binds every invariant header field to the accepted stream", async () => {
  const { protocol, close } = await loadProtocol();
  try {
    const seal = { kdf: 1, iterations: 600_000, salt: new Uint8Array(16), nonce: new Uint8Array(12) };
    const base = { sessionId: 7, seq: 1, k: 2, blockLen: 64, totalLen: 100, payloadFnv: 99, seal };
    assert.equal(protocol.sameFrameStream(base, { ...base, seq: 500 }), true);
    for (const changed of [
      { ...base, sessionId: 8 }, { ...base, k: 3 }, { ...base, blockLen: 32 },
      { ...base, totalLen: 99 }, { ...base, payloadFnv: 100 },
      { ...base, seal: { ...seal, nonce: new Uint8Array(12).fill(1) } },
    ]) assert.equal(protocol.sameFrameStream(base, changed), false);
  } finally {
    await close();
  }
});
