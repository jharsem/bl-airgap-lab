// Payload confidentiality (v1: shared passphrase).
//
// Encrypt-then-fountain. The payload is sealed exactly once and the fountain
// codes the resulting ciphertext, which keeps the stream rateless: frames stay
// interchangeable, no frame carries its own nonce, and a receiver can still
// lock on mid-flight. Sealing per frame would cost a nonce per frame and buy
// nothing.
//
// AES-256-GCM is authenticated, so the tag is what actually detects tampering.
// The FNV-1a value in the frame header is a reassembly check only — it is
// keyless and trivially forgeable, and must never be presented to a user as a
// security property. An unsealed transfer is unauthenticated: anyone who can
// put frames in front of the camera can substitute the payload.
//
// Key agreement here is a passphrase carried out of band, which makes this
// usable for one-to-many broadcast (a room that shares the phrase) at the cost
// of every shared-secret weakness: no per-recipient revocation, no sender
// authentication, and a recording stays decryptable by anyone who ever learned
// the phrase.

export const SALT_LEN = 16;
export const NONCE_LEN = 12;
export const KDF_PBKDF2_SHA256 = 1;

// OWASP's floor for PBKDF2-HMAC-SHA256. Stored in the header in thousands, so
// a receiver derives with whatever the sender used rather than a build-time
// constant.
export const DEFAULT_ITERATIONS = 600_000;

export interface SealParams {
  kdf: number;
  iterations: number;
  salt: Uint8Array;
  nonce: Uint8Array;
}

export interface SealedPayload extends SealParams {
  ciphertext: Uint8Array;
}

// TypeScript models Uint8Array as generic over ArrayBufferLike, which WebCrypto's
// BufferSource does not accept. These are always plain ArrayBuffers at runtime.
const src = (bytes: Uint8Array): BufferSource => bytes as BufferSource;

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", src(bytes));
  return new Uint8Array(digest);
}

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

/** Short fingerprint for out-of-band comparison — display only, never a check. */
export function fingerprint(digest: Uint8Array): string {
  return toHex(digest.subarray(0, 8)).replace(/(.{4})/g, "$1 ").trim();
}

async function deriveKey(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw", src(new TextEncoder().encode(passphrase)), "PBKDF2", false, ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: src(salt), iterations, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function seal(
  plaintext: Uint8Array,
  passphrase: string,
  iterations = DEFAULT_ITERATIONS,
): Promise<SealedPayload> {
  const salt = new Uint8Array(SALT_LEN);
  const nonce = new Uint8Array(NONCE_LEN);
  crypto.getRandomValues(salt);
  crypto.getRandomValues(nonce);
  const key = await deriveKey(passphrase, salt, iterations);
  const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv: src(nonce) }, key, src(plaintext));
  return { ciphertext: new Uint8Array(sealed), salt, nonce, iterations, kdf: KDF_PBKDF2_SHA256 };
}

/**
 * Returns null when the passphrase is wrong or the ciphertext was altered.
 * GCM cannot distinguish those two cases, and neither should the caller —
 * reporting "wrong passphrase" versus "tampered" would leak which one it was.
 */
export async function unseal(
  ciphertext: Uint8Array,
  passphrase: string,
  params: SealParams,
): Promise<Uint8Array | null> {
  if (params.kdf !== KDF_PBKDF2_SHA256) return null;
  try {
    const key = await deriveKey(passphrase, params.salt, params.iterations);
    const opened = await crypto.subtle.decrypt({ name: "AES-GCM", iv: src(params.nonce) }, key, src(ciphertext));
    return new Uint8Array(opened);
  } catch {
    return null;
  }
}
