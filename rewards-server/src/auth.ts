import { createHash, createHmac, createPublicKey, randomBytes, timingSafeEqual, verify } from "node:crypto";
import bs58 from "bs58";
import { type DB, now } from "./db.js";

const NONCE_TTL = 5 * 60;
const SESSION_TTL = 30 * 24 * 3600;
const HMAC_MAX_SKEW = 120;

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export function isWalletAddress(s: unknown): s is string {
  if (typeof s !== "string" || s.length < 32 || s.length > 44) return false;
  try {
    return bs58.decode(s).length === 32;
  } catch {
    return false;
  }
}

/** Verify an ed25519 signature made by a Solana wallet (e.g. Phantom signMessage). */
export function verifyWalletSignature(wallet: string, message: string, signatureB58: string): boolean {
  try {
    const pub = bs58.decode(wallet);
    const sig = bs58.decode(signatureB58);
    if (pub.length !== 32 || sig.length !== 64) return false;
    const key = createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(pub).toString("base64url") },
      format: "jwk",
    });
    return verify(null, Buffer.from(message, "utf8"), key, Buffer.from(sig));
  } catch {
    return false;
  }
}

export function issueNonce(db: DB, wallet: string, origin: string): string {
  const nonce = randomBytes(16).toString("hex");
  const message =
    `Sign in to ${origin}\n\n` +
    `This only proves you own this wallet. It does not move funds.\n\n` +
    `Wallet: ${wallet}\nNonce: ${nonce}\nIssued: ${new Date().toISOString()}`;
  db.prepare(
    `INSERT INTO auth_nonces (wallet, nonce, message, expires_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(wallet) DO UPDATE SET nonce = excluded.nonce, message = excluded.message, expires_at = excluded.expires_at`,
  ).run(wallet, nonce, message, now() + NONCE_TTL);
  return message;
}

/** Consumes the nonce. Returns a session token, or null if the signature is wrong or stale. */
export function verifySignIn(db: DB, wallet: string, signature: string): { token: string; accountId: number } | null {
  const row = db.prepare(`SELECT message, expires_at FROM auth_nonces WHERE wallet = ?`).get(wallet) as
    | { message: string; expires_at: number }
    | undefined;
  if (!row || row.expires_at < now()) return null;
  if (!verifyWalletSignature(wallet, row.message, signature)) return null;
  db.prepare(`DELETE FROM auth_nonces WHERE wallet = ?`).run(wallet);

  db.prepare(`INSERT OR IGNORE INTO accounts (wallet, created_at) VALUES (?, ?)`).run(wallet, now());
  const acct = db.prepare(`SELECT id FROM accounts WHERE wallet = ?`).get(wallet) as { id: number };
  const token = randomBytes(32).toString("base64url");
  db.prepare(`INSERT INTO sessions (token_hash, account_id, expires_at) VALUES (?, ?, ?)`).run(
    sha256(token),
    acct.id,
    now() + SESSION_TTL,
  );
  return { token, accountId: acct.id };
}

export function accountForSession(db: DB, token: string | undefined): number | null {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT s.account_id AS id FROM sessions s JOIN accounts a ON a.id = s.account_id
       WHERE s.token_hash = ? AND s.expires_at > ? AND a.banned = 0`,
    )
    .get(sha256(token), now()) as { id: number } | undefined;
  return row?.id ?? null;
}

/** Signature the Forge server sends: hex(HMAC-SHA256(secret, `${timestamp}.${body}`)). */
export function signServerRequest(secret: string, timestamp: string, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

export function verifyServerRequest(secret: string, timestamp: string | undefined, signature: string | undefined, body: string): boolean {
  if (!timestamp || !signature || !/^\d+$/.test(timestamp) || !/^[0-9a-f]{64}$/.test(signature)) return false;
  if (Math.abs(now() - Number(timestamp)) > HMAC_MAX_SKEW) return false;
  const expected = Buffer.from(signServerRequest(secret, timestamp, body), "hex");
  return timingSafeEqual(expected, Buffer.from(signature, "hex"));
}

export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}
