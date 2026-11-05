import { randomBytes } from "node:crypto";
import bs58 from "bs58";
import type { Config } from "./config.js";
import { toBaseUnits } from "./config.js";
import { type DB, now, tx } from "./db.js";

export class ClaimError extends Error {
  constructor(message: string, readonly code = 400) {
    super(message);
  }
}

interface RewardRow {
  id: number;
  account_id: number;
  amount: string;
  status: string;
  wallet: string | null;
}

function sumSince(db: DB, where: string, ...params: (string | number)[]): bigint {
  const rows = db
    .prepare(`SELECT amount FROM rewards WHERE claimed_at > ? AND status IN ('pending_approval','approved','sending','sent','needs_review') ${where}`)
    .all(now() - 86400, ...params) as { amount: string }[];
  return rows.reduce((acc, r) => acc + BigInt(r.amount), 0n);
}

/** Player asks to be paid for a reward they earned. Applies account age and daily caps. */
export function claimReward(db: DB, cfg: Config, accountId: number, rewardId: number) {
  return tx(db, () => {
    const acct = db.prepare(`SELECT wallet, banned, created_at FROM accounts WHERE id = ?`).get(accountId) as
      | { wallet: string; banned: number; created_at: number }
      | undefined;
    if (!acct || acct.banned) throw new ClaimError("account not allowed to claim", 403);
    if (now() - acct.created_at < cfg.minAccountAgeHoursToClaim * 3600) {
      throw new ClaimError(`accounts can claim after ${cfg.minAccountAgeHoursToClaim}h`);
    }
    const reward = db.prepare(`SELECT * FROM rewards WHERE id = ? AND account_id = ?`).get(rewardId, accountId) as
      | RewardRow
      | undefined;
    if (!reward) throw new ClaimError("reward not found", 404);
    if (reward.status !== "available") throw new ClaimError(`reward is already ${reward.status}`);

    const amount = BigInt(reward.amount);
    const acctCap = toBaseUnits(cfg.accountDailyCap, cfg.rewardDecimals);
    const globalCap = toBaseUnits(cfg.globalDailyCap, cfg.rewardDecimals);
    if (sumSince(db, "AND account_id = ?", accountId) + amount > acctCap) {
      throw new ClaimError("daily claim limit reached for this account, try again tomorrow", 429);
    }
    if (sumSince(db, "") + amount > globalCap) {
      throw new ClaimError("today's reward pool is used up, try again tomorrow", 429);
    }

    const status = cfg.claimMode === "auto" ? "approved" : "pending_approval";
    db.prepare(`UPDATE rewards SET status = ?, wallet = ?, claimed_at = ? WHERE id = ?`).run(status, acct.wallet, now(), rewardId);
    return { id: rewardId, status };
  });
}

export function approveClaim(db: DB, rewardId: number) {
  const res = db.prepare(`UPDATE rewards SET status = 'approved' WHERE id = ? AND status = 'pending_approval'`).run(rewardId);
  if (res.changes === 0) throw new ClaimError("claim is not pending approval", 409);
}

/** Rejected rewards are not re-claimable; set status back to 'available' by hand if that was a mistake. */
export function rejectClaim(db: DB, rewardId: number, reason: string) {
  const res = db
    .prepare(`UPDATE rewards SET status = 'rejected', error = ? WHERE id = ? AND status IN ('pending_approval','approved')`)
    .run(reason, rewardId);
  if (res.changes === 0) throw new ClaimError("claim cannot be rejected in its current state", 409);
}

/** Admin confirmed on-chain that a needs_review transfer did (sent) or did not (approved => retry) land. */
export function resolveReview(db: DB, rewardId: number, landed: boolean) {
  const res = db
    .prepare(`UPDATE rewards SET status = ?, sent_at = CASE WHEN ? THEN ? ELSE sent_at END WHERE id = ? AND status = 'needs_review'`)
    .run(landed ? "sent" : "approved", landed ? 1 : 0, now(), rewardId);
  if (res.changes === 0) throw new ClaimError("claim is not in needs_review", 409);
}

export interface Transfer {
  /** Signs the transfer and returns its signature without sending it. */
  prepare(wallet: string, amount: bigint): Promise<{ signature: string; send: () => Promise<void> }>;
}

export function dryRunTransfer(): Transfer {
  return {
    async prepare() {
      return { signature: `dryrun-${bs58.encode(randomBytes(32))}`, send: async () => {} };
    },
  };
}

export async function solanaTransfer(cfg: Config): Promise<Transfer> {
  const web3 = await import("@solana/web3.js");
  const spl = await import("@solana/spl-token");
  const conn = new web3.Connection(cfg.solanaRpcUrl, "confirmed");
  const secret = cfg.treasurySecretKey.trim().startsWith("[")
    ? Uint8Array.from(JSON.parse(cfg.treasurySecretKey))
    : bs58.decode(cfg.treasurySecretKey.trim());
  const treasury = web3.Keypair.fromSecretKey(secret);
  const mint = new web3.PublicKey(cfg.rewardMint);
  const mintInfo = await spl.getMint(conn, mint);
  if (mintInfo.decimals !== cfg.rewardDecimals) {
    throw new Error(`REWARD_DECIMALS=${cfg.rewardDecimals} but mint has ${mintInfo.decimals} decimals`);
  }
  const fromAta = spl.getAssociatedTokenAddressSync(mint, treasury.publicKey);
  console.log(`[payouts] live mode: treasury ${treasury.publicKey.toBase58()} mint ${mint.toBase58()}`);

  return {
    async prepare(wallet, amount) {
      const owner = new web3.PublicKey(wallet);
      const toAta = spl.getAssociatedTokenAddressSync(mint, owner, true);
      const tx = new web3.Transaction().add(
        // Creates the player's token account if missing; the treasury pays the rent.
        spl.createAssociatedTokenAccountIdempotentInstruction(treasury.publicKey, toAta, owner, mint),
        spl.createTransferCheckedInstruction(fromAta, mint, toAta, treasury.publicKey, amount, cfg.rewardDecimals),
      );
      const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      tx.feePayer = treasury.publicKey;
      tx.sign(treasury);
      const signature = bs58.encode(tx.signature!);
      const raw = tx.serialize();
      return {
        signature,
        send: async () => {
          await conn.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 5 });
          const res = await conn.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
          if (res.value.err) throw new Error(`transaction failed: ${JSON.stringify(res.value.err)}`);
        },
      };
    },
  };
}

/**
 * Pays one approved claim. The signature is stored before broadcasting, so if the process
 * dies or the send errors after that point the claim lands in needs_review instead of being
 * paid twice. An admin checks the signature on an explorer and resolves it.
 */
export async function processNextPayout(db: DB, transfer: Transfer): Promise<boolean> {
  const row = db.prepare(`SELECT * FROM rewards WHERE status = 'approved' ORDER BY claimed_at LIMIT 1`).get() as
    | RewardRow
    | undefined;
  if (!row) return false;
  const lock = db.prepare(`UPDATE rewards SET status = 'sending' WHERE id = ? AND status = 'approved'`).run(row.id);
  if (lock.changes === 0) return true;

  let prepared: Awaited<ReturnType<Transfer["prepare"]>>;
  try {
    prepared = await transfer.prepare(row.wallet!, BigInt(row.amount));
  } catch (e) {
    // Nothing was broadcast; safe to put it back in the queue.
    db.prepare(`UPDATE rewards SET status = 'approved', error = ? WHERE id = ?`).run(String(e), row.id);
    throw e;
  }
  db.prepare(`UPDATE rewards SET signature = ? WHERE id = ?`).run(prepared.signature, row.id);
  try {
    await prepared.send();
    db.prepare(`UPDATE rewards SET status = 'sent', sent_at = ?, error = NULL WHERE id = ?`).run(now(), row.id);
  } catch (e) {
    db.prepare(`UPDATE rewards SET status = 'needs_review', error = ? WHERE id = ?`).run(String(e), row.id);
  }
  return true;
}

/** On startup: anything left in 'sending' was interrupted mid-send and must be checked by hand. */
export function recoverInterrupted(db: DB) {
  db.prepare(`UPDATE rewards SET status = 'needs_review', error = 'interrupted during send' WHERE status = 'sending'`).run();
}

export function startPayoutWorker(db: DB, transfer: Transfer, intervalMs = 5000) {
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      while (await processNextPayout(db, transfer)) {}
    } catch (e) {
      console.error("[payouts]", e);
    } finally {
      busy = false;
    }
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
