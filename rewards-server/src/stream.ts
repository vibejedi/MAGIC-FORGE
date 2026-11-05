import { randomBytes } from "node:crypto";
import http, { type IncomingMessage, type Server } from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";
import { sha256 } from "./auth.js";
import type { Config } from "./config.js";
import { type DB, now } from "./db.js";

/**
 * Browser play: a fixed pool of "stream slots", each a container running the Forge desktop app
 * under a virtual display, exposed through noVNC. A signed-in player claims a free slot; the
 * slot's launcher sees the assignment, starts Forge with the player's name, and the player
 * watches/controls it at /stream/<slot>/. Only the browser holding that session's cookie can
 * reach the slot.
 */

export const COOKIE = "mc_stream";

export interface StreamSession {
  slot: number;
  accountId: number;
  username: string;
  expiresAt: number;
  startedAt: number;
}

export const slotIp = (cfg: Config, slot: number) => `${cfg.streamSubnetPrefix}${10 + slot}`;
export const slotPort = (cfg: Config, slot: number) => cfg.streamPortBase + slot;
export const streamUrl = (slot: number) =>
  `/stream/${slot}/vnc.html?autoconnect=1&resize=scale&reconnect=1&path=stream/${slot}/websockify`;

export function streamAllowed(cfg: Config, username: string | null): boolean {
  if (!username || cfg.streamSlots === 0) return false;
  if (cfg.streamAllowedUsers.includes("*")) return true;
  return cfg.streamAllowedUsers.includes(username.toLowerCase());
}

function sessionForAccount(db: DB, accountId: number): StreamSession | undefined {
  return db
    .prepare(
      `SELECT s.slot, s.account_id AS accountId, a.username, s.expires_at AS expiresAt, s.started_at AS startedAt
       FROM stream_sessions s JOIN accounts a ON a.id = s.account_id
       WHERE s.account_id = ? AND s.expires_at > ?`,
    )
    .get(accountId, now()) as StreamSession | undefined;
}

export function streamStatus(db: DB, cfg: Config, accountId: number, username: string | null) {
  const busy = (db.prepare(`SELECT COUNT(*) AS n FROM stream_sessions WHERE expires_at > ?`).get(now()) as { n: number }).n;
  const mine = sessionForAccount(db, accountId);
  return {
    enabled: cfg.streamSlots > 0,
    allowed: streamAllowed(cfg, username),
    slots: cfg.streamSlots,
    free: Math.max(0, cfg.streamSlots - busy),
    session: mine ? { slot: mine.slot, expiresAt: mine.expiresAt, url: streamUrl(mine.slot) } : null,
  };
}

export class StreamError extends Error {
  constructor(message: string, readonly code = 400) {
    super(message);
  }
}

/**
 * Claims a slot (or renews the player's current one) and returns a fresh cookie ticket.
 * Also arms ranked play for the slot's container IP, since that's where Forge connects from.
 */
export function startStream(db: DB, cfg: Config, accountId: number) {
  const acct = db.prepare(`SELECT username FROM accounts WHERE id = ?`).get(accountId) as { username: string | null };
  if (!acct.username) throw new StreamError("pick a username first");
  if (!streamAllowed(cfg, acct.username)) throw new StreamError("browser play is invite-only during testing", 403);

  const ticket = randomBytes(32).toString("base64url");
  const t = now();
  const expiresAt = t + cfg.streamSessionMinutes * 60;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`DELETE FROM stream_sessions WHERE expires_at <= ?`).run(t);
    let slot = sessionForAccount(db, accountId)?.slot;
    if (slot === undefined) {
      const taken = new Set(
        (db.prepare(`SELECT slot FROM stream_sessions WHERE expires_at > ?`).all(t) as { slot: number }[]).map((r) => r.slot),
      );
      for (let s = 1; s <= cfg.streamSlots; s++) {
        if (!taken.has(s)) {
          slot = s;
          break;
        }
      }
      if (slot === undefined) throw new StreamError("all browser seats are in use, try again in a few minutes", 429);
      db.prepare(
        `INSERT INTO stream_sessions (slot, account_id, ticket_hash, expires_at, started_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(slot) DO UPDATE SET account_id = excluded.account_id, ticket_hash = excluded.ticket_hash,
           expires_at = excluded.expires_at, started_at = excluded.started_at`,
      ).run(slot, accountId, sha256(ticket), expiresAt, t);
    } else {
      db.prepare(`UPDATE stream_sessions SET ticket_hash = ?, expires_at = ? WHERE slot = ?`).run(sha256(ticket), expiresAt, slot);
    }
    db.prepare(
      `INSERT INTO arms (account_id, ip, expires_at) VALUES (?, ?, ?)
       ON CONFLICT(account_id) DO UPDATE SET ip = excluded.ip, expires_at = excluded.expires_at`,
    ).run(accountId, slotIp(cfg, slot), expiresAt);
    db.exec("COMMIT");
    return { slot, ticket, expiresAt, url: streamUrl(slot) };
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function stopStream(db: DB, accountId: number) {
  db.prepare(`DELETE FROM stream_sessions WHERE account_id = ?`).run(accountId);
  db.prepare(`DELETE FROM arms WHERE account_id = ?`).run(accountId);
}

/** What the slot's launcher should be running: a player's Forge, or nothing. */
export function slotAssignment(db: DB, slot: number) {
  const row = db
    .prepare(
      `SELECT a.username, s.started_at AS startedAt, s.account_id AS accountId FROM stream_sessions s
       JOIN accounts a ON a.id = s.account_id WHERE s.slot = ? AND s.expires_at > ? AND a.banned = 0`,
    )
    .get(slot, now()) as { username: string; startedAt: number; accountId: number } | undefined;
  return row ? { username: row.username, session: `${row.accountId}-${row.startedAt}` } : { username: null, session: null };
}

export function cookieHeader(cfg: Config, ticket: string, maxAgeSec: number): string {
  const secure = cfg.publicOrigin.startsWith("https://") ? "; Secure" : "";
  return `${COOKIE}=${ticket}; Path=/stream/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${secure}`;
}

function readCookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}

/** Parses /stream/<slot>/<rest> and checks the request carries that slot's live ticket. */
export function authorizeStreamRequest(
  db: DB,
  cfg: Config,
  req: IncomingMessage,
): { slot: number; rest: string; ticketHash: string } | null {
  const m = /^\/stream\/(\d{1,2})(\/.*)?$/.exec((req.url ?? "").split("?")[0]);
  if (!m) return null;
  const slot = Number(m[1]);
  if (slot < 1 || slot > cfg.streamSlots) return null;
  const ticket = readCookie(req, COOKIE);
  if (!ticket) return null;
  const ticketHash = sha256(ticket);
  if (!ticketStillValid(db, slot, ticketHash)) return null;
  const query = (req.url ?? "").includes("?") ? (req.url ?? "").slice((req.url ?? "").indexOf("?")) : "";
  return { slot, rest: (m[2] ?? "/") + query, ticketHash };
}

function ticketStillValid(db: DB, slot: number, ticketHash: string): boolean {
  return !!db
    .prepare(`SELECT 1 FROM stream_sessions WHERE slot = ? AND ticket_hash = ? AND expires_at > ?`)
    .get(slot, ticketHash, now());
}

/** Express-compatible handler for plain HTTP under /stream/ (the noVNC page and its assets). */
export function streamHttpProxy(db: DB, cfg: Config) {
  return (req: IncomingMessage, res: http.ServerResponse) => {
    const auth = authorizeStreamRequest(db, cfg, req);
    if (!auth) {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("This browser session has ended or belongs to someone else. Start a new one from the home page.");
      return;
    }
    const upstream = http.request(
      { host: "127.0.0.1", port: slotPort(cfg, auth.slot), method: req.method, path: auth.rest, headers: { ...req.headers, host: "127.0.0.1" } },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
      res.end("Your browser seat is starting up. Reload in a few seconds.");
    });
    req.pipe(upstream);
  };
}

/** WebSocket upgrades under /stream/ (the VNC connection itself) go straight to the slot. */
export function attachStreamUpgrade(server: Server, db: DB, cfg: Config, sweepMs = 5000) {
  // Open VNC connections outlive the HTTP request that authorised them, so re-check them:
  // when a session ends (stopped, expired or renewed with a new ticket) its viewer is cut off
  // before the slot can be handed to someone else.
  const live = new Set<{ slot: number; ticketHash: string; close: () => void }>();
  const sweep = setInterval(() => {
    for (const c of live) {
      if (!ticketStillValid(db, c.slot, c.ticketHash)) c.close();
    }
  }, sweepMs);
  sweep.unref();
  server.on("close", () => clearInterval(sweep));

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const auth = authorizeStreamRequest(db, cfg, req);
    if (!auth) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    const upstream = net.connect(slotPort(cfg, auth.slot), "127.0.0.1", () => {
      const lines = [`${req.method} ${auth.rest} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const key = req.rawHeaders[i];
        if (key.toLowerCase() === "host") lines.push("Host: 127.0.0.1");
        else lines.push(`${key}: ${req.rawHeaders[i + 1]}`);
      }
      upstream.write(lines.join("\r\n") + "\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    const entry = {
      slot: auth.slot,
      ticketHash: auth.ticketHash,
      close: () => {
        live.delete(entry);
        upstream.destroy();
        socket.destroy();
      },
    };
    live.add(entry);
    upstream.on("error", entry.close);
    upstream.on("close", entry.close);
    socket.on("error", entry.close);
    socket.on("close", entry.close);
  });
}
