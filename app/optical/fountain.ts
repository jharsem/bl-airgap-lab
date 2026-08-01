// Deterministic robust-soliton LT fountain coding.
//
// Adapted from Decimen Optical Transfer (shared/fountain.ts) by BashAlarmist,
// MIT licensed. See THIRD-PARTY-NOTICES.md.
// https://github.com/bashalarmistalt/decimen-optical-transfer
//
// deterministicLog() below is the load-bearing detail inherited from that
// work: sender and receiver must build bit-identical degree distributions,
// but Math.log is implementation-approximated, so V8 and JavaScriptCore can
// differ by an ulp and silently desynchronize the two streams. This uses only
// exactly-specified IEEE-754 operations.

import { splitmix32 } from "./protocol";

const LN2 = 0.6931471805599453;
const SOLITON_C = 0.1;
const SOLITON_DELTA = 0.5;

function deterministicLog(x: number): number {
  let exponent = 0;
  let mantissa = x;
  while (mantissa >= 1.5) { mantissa /= 2; exponent += 1; }
  while (mantissa < 0.75) { mantissa *= 2; exponent -= 1; }
  const z = (mantissa - 1) / (mantissa + 1);
  const z2 = z * z;
  let term = z;
  let sum = 0;
  for (let n = 1; n <= 21; n += 2) { sum += term / n; term *= z2; }
  return exponent * LN2 + 2 * sum;
}

function solitonCdf(k: number): Float64Array {
  const cdf = new Float64Array(k);
  if (k === 1) { cdf[0] = 1; return cdf; }
  const r = Math.max(1, SOLITON_C * deterministicLog(k / SOLITON_DELTA) * Math.sqrt(k));
  const spike = Math.min(k, Math.ceil(k / r));
  let total = 0;
  for (let degree = 1; degree <= k; degree += 1) {
    const rho = degree === 1 ? 1 / k : 1 / (degree * (degree - 1));
    let tau = 0;
    if (degree < spike) tau = r / (degree * k);
    else if (degree === spike) tau = (r * Math.max(0, deterministicLog(r / SOLITON_DELTA))) / k;
    total += rho + tau;
    cdf[degree - 1] = total;
  }
  for (let index = 0; index < k; index += 1) cdf[index] /= total;
  cdf[k - 1] = 1;
  return cdf;
}

function frameSeed(sessionId: number, sequence: number): number {
  let hash = (Math.imul(sessionId + 1, 0x9e3779b1) ^ (sequence + 0x85ebca6b)) | 0;
  hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35);
  return (hash ^ (hash >>> 16)) | 0;
}

function frameIndices(k: number, cdf: Float64Array, sessionId: number, sequence: number): number[] {
  const random = splitmix32(frameSeed(sessionId, sequence));
  const sample = random() * 2 ** -32;
  let low = 0;
  let high = k - 1;
  while (low < high) { const mid = (low + high) >> 1; if (cdf[mid] >= sample) high = mid; else low = mid + 1; }
  const degree = Math.min(k, low + 1);
  if (degree > k >> 3) {
    const scratch = new Uint32Array(k);
    for (let index = 0; index < k; index += 1) scratch[index] = index;
    const output = new Array<number>(degree);
    for (let index = 0; index < degree; index += 1) {
      const swap = index + (random() % (k - index));
      [scratch[index], scratch[swap]] = [scratch[swap], scratch[index]];
      output[index] = scratch[index];
    }
    return output;
  }
  const selected = new Set<number>();
  while (selected.size < degree) selected.add(random() % k);
  return [...selected];
}

function xorWords(target: Uint32Array, source: Uint32Array) {
  for (let index = 0; index < target.length; index += 1) target[index] = (target[index] ^ source[index]) >>> 0;
}

export class LTEncoder {
  readonly k: number;
  private readonly words: number;
  private readonly blocks: Uint32Array;
  private readonly cdf: Float64Array;

  constructor(payload: Uint8Array, readonly blockLen: number, readonly sessionId: number) {
    this.k = Math.max(1, Math.ceil(payload.length / blockLen));
    this.words = Math.ceil(blockLen / 4);
    this.blocks = new Uint32Array(this.k * this.words);
    const bytes = new Uint8Array(this.blocks.buffer);
    for (let block = 0; block < this.k; block += 1) bytes.set(payload.subarray(block * blockLen, Math.min((block + 1) * blockLen, payload.length)), block * this.words * 4);
    this.cdf = solitonCdf(this.k);
  }

  encode(sequence: number): Uint8Array {
    const output = new Uint32Array(this.words);
    for (const block of frameIndices(this.k, this.cdf, this.sessionId, sequence)) {
      const offset = block * this.words;
      for (let word = 0; word < this.words; word += 1) output[word] = (output[word] ^ this.blocks[offset + word]) >>> 0;
    }
    return new Uint8Array(output.buffer, 0, this.blockLen);
  }
}

interface PendingFrame { indices: Set<number>; words: Uint32Array }

export class LTDecoder {
  private readonly words: number;
  private readonly cdf: Float64Array;
  private readonly solved: (Uint32Array | null)[];
  private readonly byBlock = new Map<number, Set<PendingFrame>>();
  private readonly seen = new Set<number>();
  solvedCount = 0;
  framesNew = 0;
  framesDup = 0;

  constructor(readonly k: number, readonly blockLen: number, readonly sessionId: number, readonly totalLen: number) {
    this.words = Math.ceil(blockLen / 4);
    this.cdf = solitonCdf(k);
    this.solved = new Array<Uint32Array | null>(k).fill(null);
  }
  get isComplete() { return this.solvedCount >= this.k; }

  addFrame(sequence: number, block: Uint8Array) {
    if (this.seen.has(sequence)) { this.framesDup += 1; return; }
    this.seen.add(sequence); this.framesNew += 1;
    if (this.isComplete) return;
    const indices = new Set(frameIndices(this.k, this.cdf, this.sessionId, sequence));
    const words = new Uint32Array(this.words);
    new Uint8Array(words.buffer).set(block.subarray(0, this.blockLen));
    for (const index of [...indices]) {
      const solved = this.solved[index];
      if (solved) { xorWords(words, solved); indices.delete(index); }
    }
    if (indices.size === 0) return;
    if (indices.size === 1) { this.resolve(indices.values().next().value!, words); return; }
    const pending = { indices, words };
    for (const index of indices) {
      let waiting = this.byBlock.get(index);
      if (!waiting) { waiting = new Set(); this.byBlock.set(index, waiting); }
      waiting.add(pending);
    }
  }

  private resolve(firstBlock: number, firstWords: Uint32Array) {
    const queue: [number, Uint32Array][] = [[firstBlock, firstWords]];
    while (queue.length) {
      const [block, words] = queue.pop()!;
      if (this.solved[block]) continue;
      this.solved[block] = words; this.solvedCount += 1;
      const waiting = this.byBlock.get(block);
      if (!waiting) continue;
      this.byBlock.delete(block);
      for (const pending of waiting) {
        xorWords(pending.words, words); pending.indices.delete(block);
        if (pending.indices.size === 1) {
          const remaining = pending.indices.values().next().value!;
          this.byBlock.get(remaining)?.delete(pending);
          if (!this.solved[remaining]) queue.push([remaining, pending.words]);
        }
      }
    }
  }

  assemble(): Uint8Array | null {
    if (!this.isComplete) return null;
    const output = new Uint8Array(this.totalLen);
    for (let block = 0; block < this.k; block += 1) {
      const start = block * this.blockLen;
      const length = Math.min(this.blockLen, this.totalLen - start);
      if (length > 0) output.set(new Uint8Array(this.solved[block]!.buffer, 0, length), start);
    }
    return output;
  }
}
