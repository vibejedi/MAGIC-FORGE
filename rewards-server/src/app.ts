import express, { type NextFunction, type Request, type Response } from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { accountForSession, isWalletAddress, issueNonce, safeEqual, verifyServerRequest, verifySignIn } from "./auth.js";
import { type Config, fromBaseUnits } from "./config.js";
import { type DB, now } from "./db.js";
import { approveClaim, ClaimError, claimReward, rejectClaim, resolveReview } from "./payouts.js";
import {
  cookieHeader, slotAssignment, startStream, stopStream, StreamError, streamHttpProxy, streamStatus,
} from "./stream.js";
import { ladderSeason, leaderboard, type MatchReport, recordAiMatch, recordMatch } from "./ranking.js";

const USERNAME = /^[A-Za-z0-9_]{3,20}$/;
const SERVER_STALE_SEC = 60;

type AuthedRequest = Request & { accountId?: number; rawBody?: string };

/** Normalise IPv4-mapped IPv6 ("::ffff:1.2.3.4") so the website and game server agree. */
export function normalizeIp(ip: string | undefined): string {
  if (!ip) return "";
  return ip.startsWith("::ffff:") ? ip.slice(7) : ip;
}

export function createApp(db: DB, cfg: Config) {
  const app = express();
  app.set("trust proxy", cfg.trustProxy ? 1 : false);
  app.disable("x-powered-by");
  app.use(
    express.json({
      limit: "32kb",
      verify: (req, _res, buf) => {
        (req as AuthedRequest).rawBody = buf.toString("utf8");
      },
    }),
  );

  // Browser play: the noVNC page and assets for a claimed slot (WebSockets are handled in server.ts).
  if (cfg.streamSlots > 0) app.use("/stream", (req, res) => streamHttpProxy(db, cfg)(Object.assign(req, { url: req.originalUrl }), res));

  const here = dirname(fileURLToPath(import.meta.url));
  app.use(express.static(join(here, "..", "public")));

  const fmt = (units: string) => fromBaseUnits(BigInt(units), cfg.rewardDecimals);

  const requirePlayer = (req: AuthedRequest, res: Response, next: NextFunction) => {
    const token = req.get("authorization")?.replace(/^Bearer /, "");
    const id = accountForSession(db, token);
    if (!id) return res.status(401).json({ error: "sign in first" });
    req.accountId = id;
    next();
  };
  const requireGameServer = (req: AuthedRequest, res: Response, next: NextFunction) => {
    const ok = verifyServerRequest(cfg.gameServerSecret, req.get("x-timestamp"), req.get("x-signature"), req.rawBody ?? "");
    if (!ok) return res.status(401).json({ error: "bad server signature" });
    next();
  };
  const requireAdmin = (req: Request, res: Response, next: NextFunction) => {
    const token = req.get("authorization")?.replace(/^Bearer /, "") ?? "";
    if (!safeEqual(token, cfg.adminToken)) return res.status(401).json({ error: "admin only" });
    next();
  };

  // ---------- public ----------
  app.get("/api/config", (_req, res) => {
    res.json({
      season: cfg.goals.season,
      token: cfg.rewardSymbol,
      claimMode: cfg.claimMode,
      payoutMode: cfg.payoutMode,
      goals: cfg.goals.goals,
    });
  });

  app.get("/api/leaderboard", (req, res) => {
    const ladder = req.query.ladder === "ai" ? "ai" : "pvp";
    const season = ladderSeason(cfg, ladder);
    res.json({ season: cfg.goals.season, ladder, rows: leaderboard(db, season) });
  });

  app.get("/api/servers", (_req, res) => {
    const rows = db.prepare(`SELECT id, address, mode, status, players, seen_at FROM servers WHERE seen_at > ? ORDER BY mode DESC, id`).all(now() - SERVER_STALE_SEC) as {
      id: string; address: string; mode: string; status: string; players: string; seen_at: number;
    }[];
    res.json(rows.map((r) => ({ id: r.id, address: r.address, mode: r.mode, status: r.status, players: JSON.parse(r.players) })));
  });

  // ---------- player auth ----------
  app.post("/api/auth/nonce", (req, res) => {
    const { wallet } = req.body ?? {};
    if (wallet !== undefined && !isWalletAddress(wallet)) return res.status(400).json({ error: "invalid wallet address" });
    res.json(issueNonce(db, cfg.publicOrigin, wallet));
  });

  app.post("/api/auth/verify", (req, res) => {
    const { wallet, signature, message } = req.body ?? {};
    const problem = !isWalletAddress(wallet)
      ? "wallet address is missing or invalid"
      : typeof signature !== "string" || signature.length < 64 || signature.length > 100
        ? "signature is missing or not base58"
        : typeof message !== "string" || message.length > 2000
          ? "signed message is missing or too long"
          : null;
    if (problem) {
      console.warn(`[auth] rejected sign-in: ${problem} (wallet=${String(wallet).slice(0, 60)})`);
      return res.status(400).json({ error: `Sign-in failed: ${problem}.` });
    }
    const out = verifySignIn(db, cfg.publicOrigin, wallet, message, signature);
    if (!out) return res.status(401).json({ error: "signature check failed, please try signing in again" });
    res.json({ token: out.token });
  });

  app.get("/api/me", requirePlayer, (req: AuthedRequest, res) => {
    const acct = db.prepare(`SELECT id, wallet, username, created_at FROM accounts WHERE id = ?`).get(req.accountId!) as {
      id: number; wallet: string; username: string | null; created_at: number;
    };
    const statsQuery = db.prepare(`SELECT rating, wins, losses, draws, games, streak, best_streak AS bestStreak FROM stats WHERE account_id = ? AND season = ?`);
    const stats = statsQuery.get(acct.id, ladderSeason(cfg, "pvp")) ?? null;
    const aiStats = statsQuery.get(acct.id, ladderSeason(cfg, "ai")) ?? null;
    const aiRankedToday = (db.prepare(`SELECT COUNT(*) AS n FROM ai_matches WHERE account_id = ? AND ranked = 1 AND created_at > ?`)
      .get(acct.id, now() - 86400) as { n: number }).n;
    const rewards = (db.prepare(`SELECT id, season, goal_id AS goalId, amount, status, signature, error, earned_at AS earnedAt FROM rewards WHERE account_id = ? ORDER BY earned_at DESC`)
      .all(acct.id) as { amount: string }[]).map((r) => ({ ...r, amount: fmt(r.amount) }));
    const arm = db.prepare(`SELECT ip, expires_at AS expiresAt FROM arms WHERE account_id = ? AND expires_at > ?`).get(acct.id, now()) ?? null;
    res.json({
      wallet: acct.wallet, username: acct.username, createdAt: acct.created_at, stats, aiStats,
      aiRankedLeftToday: Math.max(0, cfg.maxAiRankedPerDay - aiRankedToday), rewards, arm,
    });
  });

  app.post("/api/me/username", requirePlayer, (req: AuthedRequest, res) => {
    const { username } = req.body ?? {};
    if (typeof username !== "string" || !USERNAME.test(username)) {
      return res.status(400).json({ error: "3-20 letters, digits or underscores" });
    }
    const current = db.prepare(`SELECT username FROM accounts WHERE id = ?`).get(req.accountId!) as { username: string | null };
    if (current.username) return res.status(409).json({ error: "username is already set and cannot be changed" });
    try {
      db.prepare(`UPDATE accounts SET username = ? WHERE id = ?`).run(username, req.accountId!);
    } catch {
      return res.status(409).json({ error: "username taken" });
    }
    res.json({ username });
  });

  /** Lets this account join a game server from the caller's IP for ARM_TTL_MINUTES. */
  app.post("/api/play/arm", requirePlayer, (req: AuthedRequest, res) => {
    const acct = db.prepare(`SELECT username FROM accounts WHERE id = ?`).get(req.accountId!) as { username: string | null };
    if (!acct.username) return res.status(400).json({ error: "pick a username first" });
    const ip = normalizeIp(req.ip);
    const expiresAt = now() + cfg.armTtlMinutes * 60;
    db.prepare(
      `INSERT INTO arms (account_id, ip, expires_at) VALUES (?, ?, ?)
       ON CONFLICT(account_id) DO UPDATE SET ip = excluded.ip, expires_at = excluded.expires_at`,
    ).run(req.accountId!, ip, expiresAt);
    res.json({ username: acct.username, ip, expiresAt });
  });

  // ---------- browser play ----------
  const usernameOf = (id: number) =>
    (db.prepare(`SELECT username FROM accounts WHERE id = ?`).get(id) as { username: string | null }).username;

  app.get("/api/stream", requirePlayer, (req: AuthedRequest, res) => {
    res.json(streamStatus(db, cfg, req.accountId!, usernameOf(req.accountId!)));
  });

  app.post("/api/stream/start", requirePlayer, (req: AuthedRequest, res) => {
    try {
      const s = startStream(db, cfg, req.accountId!);
      res.setHeader("Set-Cookie", cookieHeader(cfg, s.ticket, cfg.streamSessionMinutes * 60));
      res.json({ slot: s.slot, expiresAt: s.expiresAt, url: s.url });
    } catch (e) {
      if (e instanceof StreamError) return res.status(e.code).json({ error: e.message });
      throw e;
    }
  });

  app.post("/api/stream/stop", requirePlayer, (req: AuthedRequest, res) => {
    stopStream(db, req.accountId!);
    res.setHeader("Set-Cookie", cookieHeader(cfg, "", 0));
    res.json({ ok: true });
  });

  /** Polled by each stream container's launcher, signed with STREAM_SECRET. */
  app.post("/api/stream/assignment", (req: AuthedRequest, res) => {
    if (cfg.streamSlots === 0) return res.status(404).json({ error: "browser play is off" });
    const ok = verifyServerRequest(cfg.streamSecret, req.get("x-timestamp"), req.get("x-signature"), req.rawBody ?? "");
    if (!ok) return res.status(401).json({ error: "bad signature" });
    const slot = Number(req.body?.slot);
    if (!Number.isInteger(slot) || slot < 1 || slot > cfg.streamSlots) return res.status(400).json({ error: "bad slot" });
    res.json(slotAssignment(db, slot));
  });

  app.post("/api/rewards/:id/claim", requirePlayer, (req: AuthedRequest, res) => {
    try {
      res.json(claimReward(db, cfg, req.accountId!, Number(req.params.id)));
    } catch (e) {
      if (e instanceof ClaimError) return res.status(e.code).json({ error: e.message });
      throw e;
    }
  });

  // ---------- game server (HMAC signed) ----------
  app.post("/api/gs/login-check", requireGameServer, (req, res) => {
    const { username, ip } = req.body ?? {};
    if (typeof username !== "string" || typeof ip !== "string") return res.status(400).json({ error: "bad request" });
    const row = db
      .prepare(
        `SELECT a.username, a.banned, r.ip, r.expires_at FROM accounts a LEFT JOIN arms r ON r.account_id = a.id
         WHERE a.username = ?`,
      )
      .get(username) as { username: string; banned: number; ip: string | null; expires_at: number | null } | undefined;
    const site = cfg.publicOrigin;
    if (!row) return res.json({ ok: false, reason: `Unknown player '${username}'. Register at ${site} and use that exact name in Forge.` });
    if (row.banned) return res.json({ ok: false, reason: "This account is banned." });
    if (!row.ip || (row.expires_at ?? 0) < now()) {
      return res.json({ ok: false, reason: `Press "Play ranked" at ${site} first, then reconnect within ${cfg.armTtlMinutes} minutes.` });
    }
    if (row.ip !== normalizeIp(ip)) {
      return res.json({ ok: false, reason: `Connect from the same network you pressed "Play ranked" on (${site}).` });
    }
    res.json({ ok: true, username: row.username });
  });

  app.post("/api/gs/heartbeat", requireGameServer, (req, res) => {
    const { serverId, address, status, players } = req.body ?? {};
    const mode = req.body?.mode === "ai" ? "ai" : "pvp";
    if (typeof serverId !== "string" || typeof address !== "string" || typeof status !== "string" || !Array.isArray(players)) {
      return res.status(400).json({ error: "bad request" });
    }
    db.prepare(
      `INSERT INTO servers (id, address, mode, status, players, seen_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET address = excluded.address, mode = excluded.mode, status = excluded.status,
         players = excluded.players, seen_at = excluded.seen_at`,
    ).run(serverId, address, mode, status, JSON.stringify(players.map(String).slice(0, 8)), now());
    res.json({ ok: true });
  });

  app.post("/api/gs/match-result", requireGameServer, (req, res) => {
    const b = req.body ?? {};
    if (b.mode === "ai") {
      const p = Array.isArray(b.players) && b.players.length === 1 ? b.players[0] : null;
      const ok =
        typeof b.matchId === "string" && b.matchId.length >= 8 && b.matchId.length <= 64 &&
        typeof b.serverId === "string" && p && typeof p.username === "string" &&
        (b.winner === null || typeof b.winner === "string") &&
        Number.isInteger(b.turns) && Number.isInteger(b.durationSec);
      if (!ok) return res.status(400).json({ error: "bad AI match report" });
      return res.json(recordAiMatch(db, cfg, {
        matchId: b.matchId, serverId: b.serverId, username: p.username, leaver: p.leaver === true,
        winner: b.winner, turns: b.turns, durationSec: b.durationSec,
      }));
    }
    const valid =
      typeof b.matchId === "string" && b.matchId.length >= 8 && b.matchId.length <= 64 &&
      typeof b.serverId === "string" &&
      Array.isArray(b.players) && b.players.length === 2 &&
      b.players.every((p: unknown) => typeof (p as { username?: unknown }).username === "string") &&
      (b.winner === null || typeof b.winner === "string") &&
      Number.isInteger(b.turns) && Number.isInteger(b.durationSec);
    if (!valid) return res.status(400).json({ error: "bad match report" });
    const report: MatchReport = {
      matchId: b.matchId,
      serverId: b.serverId,
      players: b.players.map((p: { username: string; leaver?: unknown }) => ({ username: p.username, leaver: p.leaver === true })),
      winner: b.winner,
      turns: b.turns,
      durationSec: b.durationSec,
    };
    res.json(recordMatch(db, cfg, report));
  });

  // ---------- admin ----------
  app.get("/api/admin/claims", requireAdmin, (req, res) => {
    const status = typeof req.query.status === "string" ? req.query.status : "pending_approval";
    const rows = db
      .prepare(
        `SELECT r.id, a.username, r.wallet, r.goal_id AS goalId, r.amount, r.status, r.signature, r.error, r.claimed_at AS claimedAt
         FROM rewards r JOIN accounts a ON a.id = r.account_id WHERE r.status = ? ORDER BY r.claimed_at`,
      )
      .all(status) as { amount: string }[];
    res.json(rows.map((r) => ({ ...r, amount: fmt(r.amount) })));
  });

  const adminAction = (fn: (id: number, body: Record<string, unknown>) => void) => (req: Request, res: Response) => {
    try {
      fn(Number(req.params.id), req.body ?? {});
      res.json({ ok: true });
    } catch (e) {
      if (e instanceof ClaimError) return res.status(e.code).json({ error: e.message });
      throw e;
    }
  };
  app.post("/api/admin/claims/:id/approve", requireAdmin, adminAction((id) => approveClaim(db, id)));
  app.post("/api/admin/claims/:id/reject", requireAdmin, adminAction((id, b) => rejectClaim(db, id, String(b.reason ?? "rejected"))));
  app.post("/api/admin/claims/:id/resolve", requireAdmin, adminAction((id, b) => resolveReview(db, id, b.landed === true)));

  app.get("/api/admin/ai-matches", requireAdmin, (_req, res) => {
    res.json(
      db.prepare(
        `SELECT m.*, a.username FROM ai_matches m JOIN accounts a ON a.id = m.account_id
         ORDER BY m.created_at DESC LIMIT 200`,
      ).all(),
    );
  });

  app.get("/api/admin/matches", requireAdmin, (_req, res) => {
    res.json(
      db.prepare(
        `SELECT m.*, pa.username AS a_name, pb.username AS b_name FROM matches m
         JOIN accounts pa ON pa.id = m.player_a JOIN accounts pb ON pb.id = m.player_b
         ORDER BY m.created_at DESC LIMIT 200`,
      ).all(),
    );
  });

  app.post("/api/admin/accounts/:username/ban", requireAdmin, (req, res) => {
    const banned = req.body?.banned !== false;
    const r = db.prepare(`UPDATE accounts SET banned = ? WHERE username = ?`).run(banned ? 1 : 0, req.params.username);
    if (r.changes === 0) return res.status(404).json({ error: "no such user" });
    if (banned) {
      db.prepare(`DELETE FROM sessions WHERE account_id = (SELECT id FROM accounts WHERE username = ?)`).run(req.params.username);
    }
    res.json({ ok: true, banned });
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error(err);
    res.status(500).json({ error: "internal error" });
  });

  return app;
}
