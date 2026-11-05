import type { Config, Goal } from "./config.js";
import { toBaseUnits } from "./config.js";
import { type DB, now, tx } from "./db.js";

export const START_RATING = 1200;
const K = 32;

export function eloDelta(ratingA: number, ratingB: number, scoreA: 0 | 0.5 | 1): number {
  const expectedA = 1 / (1 + 10 ** ((ratingB - ratingA) / 400));
  return Math.round(K * (scoreA - expectedA));
}

export interface MatchReport {
  matchId: string;
  serverId: string;
  /** Exactly two Forge player names, which are account usernames. */
  players: { username: string; leaver: boolean }[];
  /** Username of the winner as Forge reported it, or null for a draw. */
  winner: string | null;
  turns: number;
  durationSec: number;
}

export interface MatchResult {
  status: "recorded" | "duplicate";
  ranked: boolean;
  note?: string;
  winnerId?: number | null;
}

interface StatsRow {
  rating: number;
  wins: number;
  losses: number;
  draws: number;
  games: number;
  streak: number;
  best_streak: number;
}

function getStats(db: DB, accountId: number, season: string): StatsRow {
  db.prepare(`INSERT OR IGNORE INTO stats (account_id, season, rating) VALUES (?, ?, ?)`).run(accountId, season, START_RATING);
  return db.prepare(`SELECT * FROM stats WHERE account_id = ? AND season = ?`).get(accountId, season) as unknown as StatsRow;
}

function putStats(db: DB, accountId: number, season: string, s: StatsRow) {
  db.prepare(
    `UPDATE stats SET rating = ?, wins = ?, losses = ?, draws = ?, games = ?, streak = ?, best_streak = ?
     WHERE account_id = ? AND season = ?`,
  ).run(s.rating, s.wins, s.losses, s.draws, s.games, s.streak, s.best_streak, accountId, season);
}

function metricValue(s: StatsRow, goal: Goal): number {
  switch (goal.metric) {
    case "wins": return s.wins;
    case "games": return s.games;
    case "rating": return s.rating;
    case "bestStreak": return s.best_streak;
  }
}

/** Grants every goal the account has now reached and has not been granted this season. */
export function grantGoals(db: DB, cfg: Config, accountId: number): string[] {
  const season = cfg.goals.season;
  const s = getStats(db, accountId, season);
  const granted: string[] = [];
  for (const goal of cfg.goals.goals) {
    if (metricValue(s, goal) < goal.target) continue;
    const res = db
      .prepare(
        `INSERT OR IGNORE INTO rewards (account_id, season, goal_id, amount, status, earned_at)
         VALUES (?, ?, ?, ?, 'available', ?)`,
      )
      .run(accountId, season, goal.id, toBaseUnits(goal.reward, cfg.rewardDecimals).toString(), now());
    if (res.changes > 0) granted.push(goal.id);
  }
  return granted;
}

/**
 * Records a result reported by the dedicated game server. Idempotent on matchId.
 *
 * Ranked only when: both players are registered and unbanned, the game lasted at least
 * MIN_TURNS_FOR_RANKED turns (unless someone left), and this pair has not already played
 * MAX_RANKED_PER_PAIR_PER_DAY ranked games in the last 24h. A player who disconnected
 * and was replaced by the AI forfeits; if both left the match is void.
 */
export function recordMatch(db: DB, cfg: Config, r: MatchReport): MatchResult {
  if (r.players.length !== 2) throw new Error("only 1v1 matches are supported");
  const season = cfg.goals.season;

  return tx(db, () => {
    if (db.prepare(`SELECT 1 FROM matches WHERE id = ?`).get(r.matchId)) return { status: "duplicate", ranked: false };

    const ids = r.players.map((p) => {
      const row = db.prepare(`SELECT id, banned FROM accounts WHERE username = ?`).get(p.username) as
        | { id: number; banned: number }
        | undefined;
      return row && !row.banned ? row.id : null;
    });
    const [a, b] = ids;
    const leavers = r.players.map((p) => p.leaver);

    let winnerIdx: 0 | 1 | null = null;
    if (leavers[0] !== leavers[1]) {
      winnerIdx = leavers[0] ? 1 : 0;
    } else if (r.winner) {
      const i = r.players.findIndex((p) => p.username.toLowerCase() === r.winner!.toLowerCase());
      winnerIdx = i === 0 || i === 1 ? i : null;
    }

    let ranked = true;
    let note: string | undefined;
    if (a == null || b == null) {
      ranked = false;
      note = "unregistered or banned player";
    } else if (a === b) {
      ranked = false;
      note = "same account on both seats";
    } else if (leavers[0] && leavers[1]) {
      ranked = false;
      note = "both players left";
    } else if (r.turns < cfg.minTurnsForRanked && !leavers.some(Boolean)) {
      ranked = false;
      note = `fewer than ${cfg.minTurnsForRanked} turns`;
    } else {
      const [lo, hi] = a < b ? [a, b] : [b, a];
      const recent = db
        .prepare(`SELECT COUNT(*) AS n FROM matches WHERE player_a = ? AND player_b = ? AND ranked = 1 AND created_at > ?`)
        .get(lo, hi, now() - 86400) as { n: number };
      if (recent.n >= cfg.maxRankedPerPairPerDay) {
        ranked = false;
        note = "pair already played the daily ranked limit";
      }
    }

    const winnerId = winnerIdx === null ? null : ids[winnerIdx];
    if (a != null && b != null) {
      const [lo, hi] = a < b ? [a, b] : [b, a];
      db.prepare(
        `INSERT INTO matches (id, server_id, season, player_a, player_b, winner, turns, duration_sec, ranked, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(r.matchId, r.serverId, season, lo, hi, winnerId, r.turns, r.durationSec, ranked ? 1 : 0, note ?? null, now());
    }
    if (!ranked || a == null || b == null) return { status: "recorded", ranked: false, note, winnerId };

    const sa = getStats(db, a, season);
    const sb = getStats(db, b, season);
    const scoreA: 0 | 0.5 | 1 = winnerIdx === null ? 0.5 : winnerIdx === 0 ? 1 : 0;
    const d = eloDelta(sa.rating, sb.rating, scoreA);
    sa.rating += d;
    sb.rating -= d;
    for (const [s, score] of [[sa, scoreA], [sb, (1 - scoreA) as 0 | 0.5 | 1]] as const) {
      s.games += 1;
      if (score === 1) {
        s.wins += 1;
        s.streak += 1;
        s.best_streak = Math.max(s.best_streak, s.streak);
      } else if (score === 0) {
        s.losses += 1;
        s.streak = 0;
      } else {
        s.draws += 1;
      }
    }
    putStats(db, a, season, sa);
    putStats(db, b, season, sb);
    grantGoals(db, cfg, a);
    grantGoals(db, cfg, b);
    return { status: "recorded", ranked: true, winnerId };
  });
}

export function leaderboard(db: DB, season: string, limit = 100) {
  return db
    .prepare(
      `SELECT a.username, s.rating, s.wins, s.losses, s.draws, s.games, s.best_streak AS bestStreak
       FROM stats s JOIN accounts a ON a.id = s.account_id
       WHERE s.season = ? AND a.banned = 0 AND s.games > 0
       ORDER BY s.rating DESC, s.wins DESC LIMIT ?`,
    )
    .all(season, limit);
}
