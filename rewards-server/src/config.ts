import { readFileSync } from "node:fs";

export type Metric = "wins" | "games" | "rating" | "bestStreak";
export type Ladder = "pvp" | "ai";

export interface Goal {
  id: string;
  title: string;
  metric: Metric;
  /** Which ladder's stats the goal counts: player-vs-player (default) or vs the AI. */
  ladder?: Ladder;
  target: number;
  /** Whole-token amount as a decimal string, e.g. "12.5". */
  reward: string;
}

export interface GoalsFile {
  season: string;
  goals: Goal[];
}

export interface Config {
  host: string;
  port: number;
  trustProxy: boolean;
  publicOrigin: string;
  databasePath: string;
  goals: GoalsFile;
  gameServerSecret: string;
  adminToken: string;
  minTurnsForRanked: number;
  maxRankedPerPairPerDay: number;
  maxAiRankedPerDay: number;
  aiRating: number;
  armTtlMinutes: number;
  minAccountAgeHoursToClaim: number;
  claimMode: "manual" | "auto";
  payoutMode: "dry-run" | "live";
  rewardSymbol: string;
  rewardDecimals: number;
  accountDailyCap: string;
  globalDailyCap: string;
  solanaRpcUrl: string;
  rewardMint: string;
  treasurySecretKey: string;
  /** Browser play (Forge streamed through noVNC). 0 slots = off. */
  streamSlots: number;
  streamSecret: string;
  streamSubnetPrefix: string;
  streamPortBase: number;
  streamSessionMinutes: number;
  /** Lowercased usernames allowed to use browser play; "*" = every signed-in player, empty = nobody. */
  streamAllowedUsers: string[];
}

const METRICS: Metric[] = ["wins", "games", "rating", "bestStreak"];

export function validateGoals(file: GoalsFile): GoalsFile {
  if (!file || typeof file.season !== "string" || !file.season) {
    throw new Error("goals file: 'season' is required");
  }
  if (!Array.isArray(file.goals)) throw new Error("goals file: 'goals' must be an array");
  const seen = new Set<string>();
  for (const g of file.goals) {
    if (!g.id || seen.has(g.id)) throw new Error(`goals file: missing or duplicate id '${g.id}'`);
    seen.add(g.id);
    if (!METRICS.includes(g.metric)) throw new Error(`goal ${g.id}: unknown metric '${g.metric}'`);
    if (g.ladder !== undefined && g.ladder !== "pvp" && g.ladder !== "ai") throw new Error(`goal ${g.id}: ladder must be pvp or ai`);
    if (!Number.isFinite(g.target) || g.target <= 0) throw new Error(`goal ${g.id}: bad target`);
    if (!/^\d+(\.\d+)?$/.test(g.reward)) throw new Error(`goal ${g.id}: reward must be a decimal string`);
  }
  return file;
}

function env(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") {
    if (fallback === undefined) throw new Error(`Missing required env var ${name}`);
    return fallback;
  }
  return v;
}

function int(name: string, fallback: number): number {
  const n = Number(env(name, String(fallback)));
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer`);
  return n;
}

export function loadConfig(): Config {
  const goalsPath = env("GOALS_PATH", "./config/goals.json");
  const goals = validateGoals(JSON.parse(readFileSync(goalsPath, "utf8")));
  const claimMode = env("CLAIM_MODE", "manual");
  const payoutMode = env("PAYOUT_MODE", "dry-run");
  if (claimMode !== "manual" && claimMode !== "auto") throw new Error("CLAIM_MODE must be manual|auto");
  if (payoutMode !== "dry-run" && payoutMode !== "live") throw new Error("PAYOUT_MODE must be dry-run|live");

  const cfg: Config = {
    host: env("HOST", "0.0.0.0"),
    port: int("PORT", 8080),
    trustProxy: env("TRUST_PROXY", "0") === "1",
    publicOrigin: env("PUBLIC_ORIGIN", "http://localhost:8080"),
    databasePath: env("DATABASE_PATH", "./data/rewards.db"),
    goals,
    gameServerSecret: env("GAME_SERVER_SECRET"),
    adminToken: env("ADMIN_TOKEN"),
    minTurnsForRanked: int("MIN_TURNS_FOR_RANKED", 4),
    maxRankedPerPairPerDay: int("MAX_RANKED_PER_PAIR_PER_DAY", 2),
    maxAiRankedPerDay: int("MAX_AI_RANKED_PER_DAY", 5),
    aiRating: int("AI_RATING", 1400),
    armTtlMinutes: int("ARM_TTL_MINUTES", 15),
    minAccountAgeHoursToClaim: int("MIN_ACCOUNT_AGE_HOURS_TO_CLAIM", 24),
    claimMode,
    payoutMode,
    rewardSymbol: env("REWARD_TOKEN_SYMBOL", "REWARD"),
    rewardDecimals: int("REWARD_DECIMALS", 6),
    accountDailyCap: env("ACCOUNT_DAILY_CAP", "500"),
    globalDailyCap: env("GLOBAL_DAILY_CAP", "10000"),
    solanaRpcUrl: env("SOLANA_RPC_URL", "https://api.mainnet-beta.solana.com"),
    rewardMint: env("REWARD_MINT", ""),
    treasurySecretKey: env("TREASURY_SECRET_KEY", ""),
    streamSlots: int("STREAM_SLOTS", 0),
    streamSecret: env("STREAM_SECRET", ""),
    streamSubnetPrefix: env("STREAM_SUBNET_PREFIX", "172.30.0."),
    streamPortBase: int("STREAM_PORT_BASE", 6080),
    streamSessionMinutes: int("STREAM_SESSION_MINUTES", 90),
    streamAllowedUsers: env("STREAM_ALLOWED_USERS", "")
      .split(",")
      .map((u) => u.trim().toLowerCase())
      .filter(Boolean),
  };
  if (cfg.gameServerSecret.length < 32) throw new Error("GAME_SERVER_SECRET must be at least 32 characters");
  if (cfg.adminToken.length < 32) throw new Error("ADMIN_TOKEN must be at least 32 characters");
  if (cfg.streamSlots > 0 && cfg.streamSecret.length < 32) {
    throw new Error("STREAM_SLOTS > 0 needs STREAM_SECRET (at least 32 characters)");
  }
  if (cfg.payoutMode === "live" && (!cfg.rewardMint || !cfg.treasurySecretKey)) {
    throw new Error("PAYOUT_MODE=live needs REWARD_MINT and TREASURY_SECRET_KEY");
  }
  return cfg;
}

/** "12.5" with 6 decimals -> 12500000n. Rejects more precision than the token supports. */
export function toBaseUnits(amount: string, decimals: number): bigint {
  if (!/^\d+(\.\d+)?$/.test(amount)) throw new Error(`bad amount '${amount}'`);
  const [whole, frac = ""] = amount.split(".");
  if (frac.length > decimals) throw new Error(`amount '${amount}' has more than ${decimals} decimals`);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
}

export function fromBaseUnits(units: bigint, decimals: number): string {
  const s = units.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}
