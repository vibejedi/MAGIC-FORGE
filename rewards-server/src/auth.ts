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

/** Fields for a Sign In With Solana (SIWS) request; wallets build the message text from these. */
export interface SignInInput {
  domain: string;
  statement: string;
  uri: string;
  version: "1";
  chainId: "mainnet";
  nonce: string;
  issuedAt: string;
  expirationTime: string;
}

const STATEMENT = "Sign in to play ranked. This only proves you own this wallet; it does not move funds.";

/** The SIWS message text, in the same layout wallets produce for solana:signIn. */
export function siwsMessage(input: SignInInput, address: string): string {
  return (
    `${input.domain} wants you to sign in with your Solana account:\n${address}\n\n${input.statement}\n\n` +
    `URI: ${input.uri}\nVersion: ${input.version}\nChain ID: ${input.chainId}\nNonce: ${input.nonce}\n` +
    `Issued At: ${input.issuedAt}\nExpiration Time: ${input.expirationTime}`
  );
}

/** Starts a sign-in. Returns the SIWS fields, plus the full message when the wallet is already known. */
export function issueNonce(db: DB, origin: string, wallet?: string): { input: SignInInput; message?: string } {
  const nonce = randomBytes(16).toString("hex");
  const issued = now();
  const input: SignInInput = {
    domain: new URL(origin).host,
    statement: STATEMENT,
    uri: origin,
    version: "1",
    chainId: "mainnet",
    nonce,
    issuedAt: new Date(issued * 1000).toISOString(),
    expirationTime: new Date((issued + NONCE_TTL) * 1000).toISOString(),
  };
  db.prepare(`DELETE FROM siws_nonces WHERE expires_at < ?`).run(issued);
  db.prepare(`INSERT INTO siws_nonces (nonce, expires_at) VALUES (?, ?)`).run(nonce, issued + NONCE_TTL);
  return { input, message: wallet ? siwsMessage(input, wallet) : undefined };
}

/**
 * Checks a signed SIWS message: it must name our domain and the signing wallet, carry a nonce we
 * issued that has not expired or been used, and be signed by that wallet. Consumes the nonce.
 * Returns a session token, or null.
 */
export function verifySignIn(
  db: DB,
  origin: string,
  wallet: string,
  message: string,
  signature: string,
): { token: string; accountId: number } | null {
  const lines = message.split("\n");
  if (lines[0] !== `${new URL(origin).host} wants you to sign in with your Solana account:`) return null;
  if (lines[1] !== wallet) return null;
  const nonce = lines.find((l) => l.startsWith("Nonce: "))?.slice(7);
  if (!nonce) return null;
  if (!verifyWalletSignature(wallet, message, signature)) return null;
  const used = db.prepare(`DELETE FROM siws_nonces WHERE nonce = ? AND expires_at >= ?`).run(nonce, now());
  if (used.changes !== 1) return null;

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
