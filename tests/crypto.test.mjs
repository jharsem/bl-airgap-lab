import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";

async function load() {
  const vite = await createServer({ appType: "custom", configFile: false, logLevel: "silent", server: { middlewareMode: true } });
  const modules = {
    crypto: await vite.ssrLoadModule("/app/optical/crypto.ts"),
    protocol: await vite.ssrLoadModule("/app/optical/protocol.ts"),
    fountain: await vite.ssrLoadModule("/app/optical/fountain.ts"),
  };
  return { ...modules, close: () => vite.close() };
}

// A low iteration count keeps the suite fast. Production uses DEFAULT_ITERATIONS.
const TEST_ITERATIONS = 1000;

test("a sealed payload survives the full optical round trip", async () => {
  const { crypto: cryptoMod, protocol, fountain, close } = await load();
  try {
    const { seal, unseal } = cryptoMod;
    const { packFrame, parseFrame, fnv1a } = protocol;
    const { LTEncoder, LTDecoder } = fountain;

    const payload = new Uint8Array(20_000);
    for (let i = 0; i < payload.length; i += 1) payload[i] = (i * 61 + 7) & 0xff;

    const sealed = await seal(payload, "correct horse battery staple", TEST_ITERATIONS);
    // Encrypt-then-fountain: the stream must carry ciphertext, not plaintext.
    assert.notDeepEqual(sealed.ciphertext.subarray(0, 64), payload.subarray(0, 64));
    // GCM appends a 16-byte tag.
    assert.equal(sealed.ciphertext.length, payload.length + 16);

    const blockLen = 980;
    const sessionId = 4711;
    const encoder = new LTEncoder(sealed.ciphertext, blockLen, sessionId);
    const header = {
      sessionId, seq: 0, k: encoder.k, blockLen,
      totalLen: sealed.ciphertext.length, payloadFnv: fnv1a(sealed.ciphertext),
      seal: { kdf: sealed.kdf, iterations: sealed.iterations, salt: sealed.salt, nonce: sealed.nonce },
    };

    // Every sealed frame must stand alone, so a receiver that joins late can
    // still open the payload. Parse a mid-stream frame and use only that.
    const midFrame = packFrame({ ...header, seq: 900 }, encoder.encode(900));
    const parsedMid = parseFrame(midFrame);
    assert.ok(parsedMid, "sealed frame should parse");
    assert.equal(parsedMid.header.seal.iterations, TEST_ITERATIONS);
    assert.deepEqual(parsedMid.header.seal.salt, sealed.salt);
    assert.deepEqual(parsedMid.header.seal.nonce, sealed.nonce);

    const decoder = new LTDecoder(encoder.k, blockLen, sessionId, sealed.ciphertext.length);
    for (let seq = 0; seq < encoder.k * 4 && !decoder.isComplete; seq += 1) {
      if (seq % 5 === 2) continue; // drop roughly one frame in five
      const parsed = parseFrame(packFrame({ ...header, seq }, encoder.encode(seq)));
      decoder.addFrame(parsed.header.seq, parsed.block);
    }
    assert.equal(decoder.isComplete, true);

    const recovered = decoder.assemble();
    assert.deepEqual(recovered, sealed.ciphertext);

    const opened = await unseal(recovered, "correct horse battery staple", parsedMid.header.seal);
    assert.deepEqual(opened, payload);
  } finally {
    await close();
  }
});

test("a wrong passphrase and a tampered payload both fail closed", async () => {
  const { crypto: cryptoMod, close } = await load();
  try {
    const { seal, unseal } = cryptoMod;
    const payload = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const sealed = await seal(payload, "right", TEST_ITERATIONS);
    const params = { kdf: sealed.kdf, iterations: sealed.iterations, salt: sealed.salt, nonce: sealed.nonce };

    assert.equal(await unseal(sealed.ciphertext, "wrong", params), null);

    // Flip one ciphertext bit; the GCM tag must reject it.
    const tampered = sealed.ciphertext.slice();
    tampered[0] ^= 0x01;
    assert.equal(await unseal(tampered, "right", params), null);

    // An unknown KDF id must not silently fall back to the default.
    assert.equal(await unseal(sealed.ciphertext, "right", { ...params, kdf: 99 }), null);

    assert.deepEqual(await unseal(sealed.ciphertext, "right", params), payload);
  } finally {
    await close();
  }
});

test("unsealed frames keep the original 20-byte header", async () => {
  const { protocol, close } = await load();
  try {
    const { packFrame, parseFrame, HEADER_LEN, SEALED_HEADER_LEN } = protocol;
    const block = new Uint8Array(64).fill(9);
    const base = { sessionId: 1, seq: 2, k: 3, blockLen: 64, totalLen: 192, payloadFnv: 123 };

    const plain = packFrame(base, block);
    assert.equal(plain.length, HEADER_LEN + 64);
    const parsedPlain = parseFrame(plain);
    assert.equal(parsedPlain.header.seal, undefined);
    assert.deepEqual(parsedPlain.block, block);

    const sealedFrame = packFrame({
      ...base,
      seal: { kdf: 1, iterations: 600_000, salt: new Uint8Array(16).fill(7), nonce: new Uint8Array(12).fill(8) },
    }, block);
    assert.equal(sealedFrame.length, SEALED_HEADER_LEN + 64);
    const parsedSealed = parseFrame(sealedFrame);
    assert.equal(parsedSealed.header.seal.iterations, 600_000);
    assert.deepEqual(parsedSealed.block, block);
    // The two frame types must not be confusable.
    assert.notEqual(plain[1], sealedFrame[1]);
  } finally {
    await close();
  }
});
