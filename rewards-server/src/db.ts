import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type DB = DatabaseSync;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS accounts (
  id          INTEGER PRIMARY KEY,
  wallet      TEXT NOT NULL UNIQUE,
  username    TEXT UNIQUE COLLATE NOCASE,
  banned      INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_nonces (
  wallet      TEXT PRIMARY KEY,
  nonce       TEXT NOT NULL,
  message     TEXT NOT NULL,
  expires_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  account_id  INTEGER NOT NULL REFERENCES accounts(id),
  expires_at  INTEGER NOT NULL
);

-- A player "arms" ranked play from the website; the game server only seats a
-- username whose connection comes from the IP that armed it.
CREATE TABLE IF NOT EXISTS arms (
  account_id  INTEGER PRIMARY KEY REFERENCES accounts(id),
  ip          TEXT NOT NULL,
  expires_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS servers (
  id          TEXT PRIMARY KEY,
  address     TEXT NOT NULL,
  status      TEXT NOT NULL,
  players     TEXT NOT NULL,
  seen_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS matches (
  id           TEXT PRIMARY KEY,
  server_id    TEXT NOT NULL,
  season       TEXT NOT NULL,
  player_a     INTEGER NOT NULL REFERENCES accounts(id),
  player_b     INTEGER NOT NULL REFERENCES accounts(id),
  winner       INTEGER REFERENCES accounts(id),
  turns        INTEGER NOT NULL,
  duration_sec INTEGER NOT NULL,
  ranked       INTEGER NOT NULL,
  note         TEXT,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS matches_pair ON matches(player_a, player_b, created_at);

CREATE TABLE IF NOT EXISTS stats (
  account_id  INTEGER NOT NULL REFERENCES accounts(id),
  season      TEXT NOT NULL,
  rating      INTEGER NOT NULL DEFAULT 1200,
  wins        INTEGER NOT NULL DEFAULT 0,
  losses      INTEGER NOT NULL DEFAULT 0,
  draws       INTEGER NOT NULL DEFAULT 0,
  games       INTEGER NOT NULL DEFAULT 0,
  streak      INTEGER NOT NULL DEFAULT 0,
  best_streak INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, season)
);

-- One row per goal an account has reached; amount is in token base units.
CREATE TABLE IF NOT EXISTS rewards (
  id          INTEGER PRIMARY KEY,
  account_id  INTEGER NOT NULL REFERENCES accounts(id),
  season      TEXT NOT NULL,
  goal_id     TEXT NOT NULL,
  amount      TEXT NOT NULL,
  -- available -> pending_approval -> approved -> sending -> sent
  --                              \-> rejected          \-> needs_review (send outcome unknown)
  status      TEXT NOT NULL,
  wallet      TEXT,
  signature   TEXT,
  error       TEXT,
  earned_at   INTEGER NOT NULL,
  claimed_at  INTEGER,
  sent_at     INTEGER,
  UNIQUE (account_id, season, goal_id)
);
CREATE INDEX IF NOT EXISTS rewards_status ON rewards(status);
`;

export function openDb(path: string): DB {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  return db;
}

/** Run fn inside a transaction; node:sqlite is synchronous so this is safe on one connection. */
export function tx<T>(db: DB, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export const now = () => Math.floor(Date.now() / 1000);
