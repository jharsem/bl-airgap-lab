// Self-describing frame protocol: every QR frame carries enough header to
// stand alone, so there is no handshake and a receiver can lock onto a stream
// mid-flight.
//
// The 20-byte data-frame layout and its 0xD1 0x0C magic bytes are adapted from
// Decimen Optical Transfer (shared/protocol.ts) by BashAlarmist, MIT licensed.
// See THIRD-PARTY-NOTICES.md.
// https://github.com/bashalarmistalt/decimen-optical-transfer
//
// The calibration packet types (CAL_*) are specific to AirGap Lab.

// Sealed frames carry the KDF parameters, salt, and nonce in every frame
// rather than in a one-off manifest frame. A manifest is the obvious
// alternative and it is wrong here: a receiver that joined late, or that
// dropped the one frame carrying it, could collect a complete ciphertext it
// has no way to open. Self-describing frames are what make late joining work,
// and that property has to extend to the crypto parameters. The cost is 32
// bytes per sealed frame; unsealed frames are unchanged.

export const HEADER_LEN = 20;
export const SEALED_HEADER_LEN = 52;
export const MAX_BLOCK_LEN = 2900;
export const MAX_PAYLOAD_LEN = 128 * 1024 * 1024;
export const MIN_PBKDF2_ITERATIONS = 100_000;
export const MAX_PBKDF2_ITERATIONS = 2_000_000;
const DATA_MAGIC0 = 0xd1;
const DATA_MAGIC1 = 0x0c;
const SEALED_MAGIC1 = 0x0e;
const CAL_MAGIC0 = 0xca;
const CAL_CONTROL = 0x10;
const CAL_DATA = 0x11;

export interface FrameSeal {
  kdf: number;
  iterations: number;
  salt: Uint8Array;
  nonce: Uint8Array;
}

export interface FrameHeader {
  sessionId: number;
  seq: number;
  k: number;
  blockLen: number;
  totalLen: number;
  /** FNV-1a over the transmitted bytes. Reassembly check only — keyless. */
  payloadFnv: number;
  /** Present when the payload is AES-GCM sealed; the fountain carries ciphertext. */
  seal?: FrameSeal;
}

export type CalibrationEvent = "start" | "end" | "complete";
export interface CalibrationPacket {
  kind: "control" | "data";
  run: number;
  event?: CalibrationEvent;
  profile: number;
  profiles: number;
  sequence: number;
  blockLen: number;
  fps: number;
  duration: number;
}

export function frameHeaderLen(sealed: boolean) {
  return sealed ? SEALED_HEADER_LEN : HEADER_LEN;
}

export function maxPayloadForBlock(blockLen: number): number {
  if (!Number.isInteger(blockLen) || blockLen < 1 || blockLen > MAX_BLOCK_LEN) return 0;
  return Math.min(MAX_PAYLOAD_LEN, blockLen * 0xffff);
}

function validFrameShape(header: FrameHeader, blockLength: number): boolean {
  return Number.isInteger(header.sessionId) && header.sessionId > 0 && header.sessionId <= 0xffff
    && Number.isInteger(header.seq) && header.seq >= 0 && header.seq <= 0xffff_ffff
    && Number.isInteger(header.k) && header.k > 0 && header.k <= 0xffff
    && Number.isInteger(header.blockLen) && header.blockLen > 0 && header.blockLen <= MAX_BLOCK_LEN
    && blockLength === header.blockLen
    && Number.isInteger(header.totalLen) && header.totalLen > 0 && header.totalLen <= maxPayloadForBlock(header.blockLen)
    && Math.ceil(header.totalLen / header.blockLen) === header.k
    && Number.isInteger(header.payloadFnv) && header.payloadFnv >= 0 && header.payloadFnv <= 0xffff_ffff;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

/** All fields that identify and describe a stream must remain fixed across its frames. */
export function sameFrameStream(left: FrameHeader, right: FrameHeader): boolean {
  if (left.sessionId !== right.sessionId || left.k !== right.k || left.blockLen !== right.blockLen
    || left.totalLen !== right.totalLen || left.payloadFnv !== right.payloadFnv
    || Boolean(left.seal) !== Boolean(right.seal)) return false;
  if (!left.seal || !right.seal) return true;
  return left.seal.kdf === right.seal.kdf && left.seal.iterations === right.seal.iterations
    && equalBytes(left.seal.salt, right.seal.salt) && equalBytes(left.seal.nonce, right.seal.nonce);
}

export function packFrame(header: FrameHeader, block: Uint8Array): Uint8Array {
  const seal = header.seal;
  if (!validFrameShape(header, block.length)) throw new RangeError("Invalid frame dimensions");
  if (seal && (seal.kdf !== 1 || seal.salt.length !== 16 || seal.nonce.length !== 12
    || seal.iterations < MIN_PBKDF2_ITERATIONS || seal.iterations > MAX_PBKDF2_ITERATIONS
    || seal.iterations % 1000 !== 0)) throw new RangeError("Invalid frame seal parameters");
  const headerLen = frameHeaderLen(Boolean(seal));
  const out = new Uint8Array(headerLen + block.length);
  const view = new DataView(out.buffer);
  view.setUint8(0, DATA_MAGIC0);
  view.setUint8(1, seal ? SEALED_MAGIC1 : DATA_MAGIC1);
  view.setUint16(2, header.sessionId, true);
  view.setUint32(4, header.seq, true);
  view.setUint16(8, header.k, true);
  view.setUint16(10, header.blockLen, true);
  view.setUint32(12, header.totalLen, true);
  view.setUint32(16, header.payloadFnv, true);
  if (seal) {
    view.setUint8(20, seal.kdf);
    view.setUint8(21, 0);
    // Iterations travel in thousands so the field fits a u16 and the receiver
    // derives with the sender's cost rather than a hardcoded one.
    view.setUint16(22, Math.round(seal.iterations / 1000), true);
    out.set(seal.salt, 24);
    out.set(seal.nonce, 40);
  }
  out.set(block, headerLen);
  return out;
}

export function parseFrame(bytes: Uint8Array): { header: FrameHeader; block: Uint8Array } | null {
  if (bytes.length < 2 || bytes[0] !== DATA_MAGIC0) return null;
  const sealed = bytes[1] === SEALED_MAGIC1;
  if (!sealed && bytes[1] !== DATA_MAGIC1) return null;
  const headerLen = frameHeaderLen(sealed);
  if (bytes.length <= headerLen) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const header: FrameHeader = {
    sessionId: view.getUint16(2, true), seq: view.getUint32(4, true),
    k: view.getUint16(8, true), blockLen: view.getUint16(10, true),
    totalLen: view.getUint32(12, true), payloadFnv: view.getUint32(16, true),
  };
  if (!validFrameShape(header, bytes.length - headerLen)) return null;
  if (sealed) {
    const iterations = view.getUint16(22, true) * 1000;
    if (view.getUint8(20) !== 1 || view.getUint8(21) !== 0
      || iterations < MIN_PBKDF2_ITERATIONS || iterations > MAX_PBKDF2_ITERATIONS) return null;
    header.seal = {
      kdf: view.getUint8(20),
      iterations,
      salt: bytes.slice(24, 40),
      nonce: bytes.slice(40, 52),
    };
  }
  return { header, block: bytes.subarray(headerLen) };
}

const EVENT_TO_BYTE: Record<CalibrationEvent, number> = { start: 0, end: 1, complete: 2 };
const BYTE_TO_EVENT: CalibrationEvent[] = ["start", "end", "complete"];

export function packCalibrationControl(run: number, event: CalibrationEvent, profile: number, profiles: number, blockLen: number, fps: number, duration: number) {
  const out = new Uint8Array(13);
  const view = new DataView(out.buffer);
  view.setUint8(0, CAL_MAGIC0); view.setUint8(1, CAL_CONTROL);
  view.setUint16(2, run, true); view.setUint8(4, EVENT_TO_BYTE[event]);
  view.setUint8(5, profile); view.setUint8(6, profiles);
  view.setUint16(7, blockLen, true); view.setUint8(9, fps); view.setUint16(10, duration, true);
  view.setUint8(12, 0xa5);
  return out;
}

export function packCalibrationData(run: number, profile: number, profiles: number, sequence: number, blockLen: number, fps: number, duration: number) {
  const out = new Uint8Array(13 + blockLen);
  const view = new DataView(out.buffer);
  view.setUint8(0, CAL_MAGIC0); view.setUint8(1, CAL_DATA);
  view.setUint16(2, run, true); view.setUint8(4, profile); view.setUint8(5, profiles);
  view.setUint16(6, sequence, true); view.setUint16(8, blockLen, true);
  view.setUint8(10, fps); view.setUint16(11, duration, true);
  crypto.getRandomValues(out.subarray(13));
  return out;
}

export function parseCalibrationPacket(bytes: Uint8Array): CalibrationPacket | null {
  if (bytes.length < 13 || bytes[0] !== CAL_MAGIC0) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes[1] === CAL_CONTROL) {
    const event = BYTE_TO_EVENT[view.getUint8(4)];
    if (!event) return null;
    const profile = view.getUint8(5); const profiles = view.getUint8(6);
    const blockLen = view.getUint16(7, true); const fps = view.getUint8(9); const duration = view.getUint16(10, true);
    if (!profiles || profiles > 12 || profile > profiles || !blockLen || blockLen > 2900 || !fps || fps > 60 || !duration) return null;
    if (event !== "complete" && profile >= profiles) return null;
    return { kind: "control", run: view.getUint16(2, true), event, profile, profiles, sequence: 0, blockLen, fps, duration };
  }
  if (bytes[1] === CAL_DATA) {
    const blockLen = view.getUint16(8, true);
    const profile = view.getUint8(4); const profiles = view.getUint8(5);
    const fps = view.getUint8(10); const duration = view.getUint16(11, true);
    if (!profiles || profiles > 12 || profile >= profiles || !blockLen || blockLen > 2900 || !fps || fps > 60 || !duration || bytes.length !== 13 + blockLen) return null;
    return { kind: "data", run: view.getUint16(2, true), profile, profiles, sequence: view.getUint16(6, true), blockLen, fps, duration };
  }
  return null;
}

export function fnv1a(bytes: Uint8Array): number {
  let hash = 0x811c9dc5;
  for (const byte of bytes) { hash ^= byte; hash = Math.imul(hash, 0x01000193); }
  return hash >>> 0;
}

export function splitmix32(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x9e3779b9) | 0;
    let value = state ^ (state >>> 16);
    value = Math.imul(value, 0x21f0aaad); value ^= value >>> 15;
    value = Math.imul(value, 0x735a2d97); value ^= value >>> 15;
    return value >>> 0;
  };
}
