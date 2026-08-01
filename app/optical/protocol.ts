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

export const HEADER_LEN = 20;
const DATA_MAGIC0 = 0xd1;
const DATA_MAGIC1 = 0x0c;
const CAL_MAGIC0 = 0xca;
const CAL_CONTROL = 0x10;
const CAL_DATA = 0x11;

export interface FrameHeader {
  sessionId: number;
  seq: number;
  k: number;
  blockLen: number;
  totalLen: number;
  payloadFnv: number;
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

export function packFrame(header: FrameHeader, block: Uint8Array): Uint8Array {
  const out = new Uint8Array(HEADER_LEN + block.length);
  const view = new DataView(out.buffer);
  view.setUint8(0, DATA_MAGIC0);
  view.setUint8(1, DATA_MAGIC1);
  view.setUint16(2, header.sessionId, true);
  view.setUint32(4, header.seq, true);
  view.setUint16(8, header.k, true);
  view.setUint16(10, header.blockLen, true);
  view.setUint32(12, header.totalLen, true);
  view.setUint32(16, header.payloadFnv, true);
  out.set(block, HEADER_LEN);
  return out;
}

export function parseFrame(bytes: Uint8Array): { header: FrameHeader; block: Uint8Array } | null {
  if (bytes.length <= HEADER_LEN || bytes[0] !== DATA_MAGIC0 || bytes[1] !== DATA_MAGIC1) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const header: FrameHeader = {
    sessionId: view.getUint16(2, true), seq: view.getUint32(4, true),
    k: view.getUint16(8, true), blockLen: view.getUint16(10, true),
    totalLen: view.getUint32(12, true), payloadFnv: view.getUint32(16, true),
  };
  if (!header.k || !header.blockLen || !header.totalLen || bytes.length !== HEADER_LEN + header.blockLen) return null;
  return { header, block: bytes.subarray(HEADER_LEN) };
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
