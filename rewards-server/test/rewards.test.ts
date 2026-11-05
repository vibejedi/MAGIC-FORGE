import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import bs58 from "bs58";
import { createApp } from "../src/app.js";
import { signServerRequest, siwsMessage } from "../src/auth.js";
import { type Config, fromBaseUnits, toBaseUnits, validateGoals } from "../src/config.js";
import { openDb, type DB } from "../src/db.js";
import { dryRunTransfer, processNextPayout, type Transfer } from "../src/payouts.js";
import { eloDelta } from "../src/ranking.js";

const SECRET = "s".repeat(40);
const ADMIN = "a".repeat(40);

function makeConfig(over: Partial<Config> = {}): Config {
  return {
    host: "127.0.0.1",
    port: 0,
    trustProxy: false,
    publicOrigin: "https://play.test",
    databasePath: ":memory:",
    goals: validateGoals({
      season: "S1",
      goals: [
        { id: "first-win", title: "First win", metric: "wins", target: 1, reward: "10" },
        { id: "wins-3", title: "3 wins", metric: "wins", target: 3, reward: "30" },
        { id: "games-2", title: "2 games", metric: "games", target: 2, reward: "5.5" },
        { id: "ai-first-win", title: "First AI win", ladder: "ai", metric: "wins", target: 1, reward: "1" },
      ],
    }),
    gameServerSecret: SECRET,
    adminToken: ADMIN,
    minTurnsForRanked: 4,
    maxRankedPerPairPerDay: 2,
    maxAiRankedPerDay: 3,
    aiRating: 1400,
    armTtlMinutes: 15,
    minAccountAgeHoursToClaim: 0,
    claimMode: "manual",
    payoutMode: "dry-run",
    rewardSymbol: "RWD",
    rewardDecimals: 6,
    accountDailyCap: "40",
    globalDailyCap: "1000",
    solanaRpcUrl: "",
    rewardMint: "",
    treasurySecretKey: "",
    streamSlots: 0,
    streamSecret: "",
    streamSubnetPrefix: "172.30.0.",
    streamPortBase: 6080,
    streamSessionMinutes: 90,
    streamAllowedUsers: [],
    ...over,
  };
}

class Player {
  readonly wallet: string;
  private readonly priv;
  token = "";
  constructor() {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    this.priv = privateKey;
    const x = publicKey.export({ format: "jwk" }).x!;
    this.wallet = bs58.encode(Buffer.from(x, "base64url"));
  }
  signText(msg: string) {
    return bs58.encode(sign(null, Buffer.from(msg, "utf8"), this.priv));
  }
}

let server: Server;
let base: string;
let db: DB;
let cfg: Config;

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}
const as = (p: Player) => ({ authorization: `Bearer ${p.token}` });
async function gs(path: string, body: unknown, secret = SECRET) {
  const raw = JSON.stringify(body);
  const ts = String(Math.floor(Date.now() / 1000));
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-timestamp": ts, "x-signature": signServerRequest(secret, ts, raw) },
    body: raw,
  });
  return { status: res.status, body: (await res.json()) as any };
}

async function signUp(name: string) {
  const p = new Player();
  const { body } = await call("POST", "/api/auth/nonce", { wallet: p.wallet });
  const v = await call("POST", "/api/auth/verify", { wallet: p.wallet, message: body.message, signature: p.signText(body.message) });
  assert.equal(v.status, 200);
  p.token = v.body.token;
  assert.equal((await call("POST", "/api/me/username", { username: name }, as(p))).status, 200);
  return p;
}

let matchSeq = 0;
const report = (a: string, b: string, winner: string | null, extra: Record<string, unknown> = {}) =>
  gs("/api/gs/match-result", {
    matchId: `match-${++matchSeq}-xxxxxxxx`,
    serverId: "gs-1",
    players: [{ username: a, leaver: false }, { username: b, leaver: false }],
    winner,
    turns: 8,
    durationSec: 600,
    ...extra,
  });

before(async () => {
  cfg = makeConfig();
  db = openDb(":memory:");
  server = createApp(db, cfg).listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

describe("units", () => {
  test("converts decimal strings to base units and back", () => {
    assert.equal(toBaseUnits("5.5", 6), 5_500_000n);
    assert.equal(toBaseUnits("10", 0), 10n);
    assert.throws(() => toBaseUnits("1.1234567", 6));
    assert.equal(fromBaseUnits(5_500_000n, 6), "5.5");
    assert.equal(fromBaseUnits(7n, 6), "0.000007");
  });
  test("elo is zero-sum and favours the underdog", () => {
    assert.equal(eloDelta(1200, 1200, 1), 16);
    assert.ok(eloDelta(1000, 1400, 1) > eloDelta(1400, 1000, 1));
  });
});

describe("sign-in", () => {
  const verify = (p: Player, message: string, signer: Player = p) =>
    call("POST", "/api/auth/verify", { wallet: p.wallet, message, signature: signer.signText(message) });

  test("message follows the Sign In With Solana layout for our domain", async () => {
    const p = new Player();
    const { body } = await call("POST", "/api/auth/nonce", { wallet: p.wallet });
    assert.ok(body.message.startsWith(`play.test wants you to sign in with your Solana account:\n${p.wallet}\n`));
    assert.match(body.message, new RegExp(`\nNonce: ${body.input.nonce}\n`));
  });

  test("accepts a message the wallet built itself from the signIn input", async () => {
    const p = new Player();
    const { body } = await call("POST", "/api/auth/nonce", {});
    assert.equal(body.message, undefined);
    assert.equal(body.input.domain, "play.test");
    const r = await verify(p, siwsMessage(body.input, p.wallet));
    assert.equal(r.status, 200);
    assert.ok(r.body.token);
  });

  test("rejects a signature from a different wallet", async () => {
    const p = new Player();
    const { body } = await call("POST", "/api/auth/nonce", { wallet: p.wallet });
    assert.equal((await verify(p, body.message, new Player())).status, 401);
  });

  test("rejects messages for another domain, another wallet or an unknown nonce", async () => {
    const p = new Player();
    const { body } = await call("POST", "/api/auth/nonce", {});
    const otherDomain = siwsMessage({ ...body.input, domain: "evil.test" }, p.wallet);
    assert.equal((await verify(p, otherDomain)).status, 401);
    const otherWallet = siwsMessage(body.input, new Player().wallet);
    assert.equal((await verify(p, otherWallet)).status, 401);
    const madeUpNonce = siwsMessage({ ...body.input, nonce: "f".repeat(32) }, p.wallet);
    assert.equal((await verify(p, madeUpNonce)).status, 401);
    // the real nonce is still usable after those failures
    assert.equal((await verify(p, siwsMessage(body.input, p.wallet))).status, 200);
  });

  test("a nonce can only be used once", async () => {
    const p = new Player();
    const { body } = await call("POST", "/api/auth/nonce", { wallet: p.wallet });
    assert.equal((await verify(p, body.message)).status, 200);
    assert.equal((await verify(p, body.message)).status, 401);
  });

  test("username is unique and permanent", async () => {
    const p = await signUp("alice_1");
    assert.equal((await call("POST", "/api/me/username", { username: "other" }, as(p))).status, 409);
    const q = new Player();
    const { body } = await call("POST", "/api/auth/nonce", { wallet: q.wallet });
    q.token = (await verify(q, body.message)).body.token;
    assert.equal((await call("POST", "/api/me/username", { username: "ALICE_1" }, as(q))).status, 409);
  });
});

describe("game server gate", () => {
  test("rejects unsigned or wrongly signed requests", async () => {
    assert.equal((await call("POST", "/api/gs/login-check", { username: "x", ip: "1.1.1.1" })).status, 401);
    assert.equal((await gs("/api/gs/login-check", { username: "x", ip: "1.1.1.1" }, "w".repeat(40))).status, 401);
  });
  test("seats a player only after arming, and only from the armed IP", async () => {
    const p = await signUp("bob_1");
    let r = await gs("/api/gs/login-check", { username: "bob_1", ip: "127.0.0.1" });
    assert.equal(r.body.ok, false);
    assert.match(r.body.reason, /Play ranked/);
    await call("POST", "/api/play/arm", {}, as(p));
    r = await gs("/api/gs/login-check", { username: "bob_1", ip: "::ffff:127.0.0.1" });
    assert.equal(r.body.ok, true);
    r = await gs("/api/gs/login-check", { username: "bob_1", ip: "8.8.8.8" });
    assert.equal(r.body.ok, false);
    r = await gs("/api/gs/login-check", { username: "nobody", ip: "127.0.0.1" });
    assert.equal(r.body.ok, false);
  });
});

describe("matches, goals and claims", () => {
  let winner: Player;
  let loser: Player;
  before(async () => {
    winner = await signUp("winner");
    loser = await signUp("loser");
  });

  test("a ranked win updates rating and unlocks goals", async () => {
    const r = await report("winner", "loser", "winner");
    assert.equal(r.body.ranked, true);
    const me = (await call("GET", "/api/me", undefined, as(winner))).body;
    assert.equal(me.stats.wins, 1);
    assert.equal(me.stats.rating, 1216);
    assert.deepEqual(me.rewards.map((x: any) => x.goalId), ["first-win"]);
    assert.equal(me.rewards[0].amount, "10");
  });

  test("duplicate match ids are ignored", async () => {
    const body = { matchId: "dup-match-1234", serverId: "gs-1", players: [{ username: "winner" }, { username: "loser" }], winner: "winner", turns: 9, durationSec: 1 };
    assert.equal((await gs("/api/gs/match-result", body)).body.status, "recorded");
    assert.equal((await gs("/api/gs/match-result", body)).body.status, "duplicate");
  });

  test("the same pair stops being ranked after the daily limit", async () => {
    const r = await report("winner", "loser", "winner");
    assert.equal(r.body.ranked, false);
    assert.match(r.body.note, /daily ranked limit/);
  });

  test("short games are unranked but a leaver always forfeits", async () => {
    const c = await signUp("carol");
    const d = await signUp("dave");
    assert.equal((await report("carol", "dave", "carol", { turns: 2 })).body.ranked, false);
    const r = await report("carol", "dave", "dave", {
      turns: 1,
      players: [{ username: "carol", leaver: false }, { username: "dave", leaver: true }],
    });
    assert.equal(r.body.ranked, true);
    const me = (await call("GET", "/api/me", undefined, as(c))).body;
    assert.equal(me.stats.wins, 1, "AI-controlled leaver's win must not count");
    void d;
  });

  test("leaderboard lists ranked players by rating", async () => {
    const { body } = await call("GET", "/api/leaderboard");
    assert.equal(body.rows[0].rating >= body.rows[body.rows.length - 1].rating, true);
    assert.ok(body.rows.some((r: any) => r.username === "winner"));
  });

  test("claim -> admin approve -> dry-run payout", async () => {
    const me = (await call("GET", "/api/me", undefined, as(winner))).body;
    const firstWin = me.rewards.find((x: any) => x.goalId === "first-win");
    const c = await call("POST", `/api/rewards/${firstWin.id}/claim`, {}, as(winner));
    assert.equal(c.body.status, "pending_approval");
    assert.equal((await call("POST", `/api/rewards/${firstWin.id}/claim`, {}, as(winner))).status, 400);
    assert.equal((await call("POST", `/api/rewards/${firstWin.id}/claim`, {}, as(loser))).status, 404);

    const pending = (await call("GET", "/api/admin/claims", undefined, { authorization: `Bearer ${ADMIN}` })).body;
    assert.equal(pending.length, 1);
    assert.equal((await call("GET", "/api/admin/claims")).status, 401);
    await call("POST", `/api/admin/claims/${firstWin.id}/approve`, {}, { authorization: `Bearer ${ADMIN}` });

    assert.equal(await processNextPayout(db, dryRunTransfer()), true);
    assert.equal(await processNextPayout(db, dryRunTransfer()), false);
    const after = (await call("GET", "/api/me", undefined, as(winner))).body.rewards.find((x: any) => x.id === firstWin.id);
    assert.equal(after.status, "sent");
    assert.match(after.signature, /^dryrun-/);
  });

  test("account daily cap blocks claims beyond the limit", async () => {
    // winner has 10 claimed; cap is 40; give them a 30 reward and a 5.5 reward
    db.prepare(`INSERT INTO rewards (account_id, season, goal_id, amount, status, earned_at) SELECT id, 'S1', 'manual-30', ?, 'available', 0 FROM accounts WHERE username = 'winner'`).run(toBaseUnits("30", 6).toString());
    db.prepare(`INSERT INTO rewards (account_id, season, goal_id, amount, status, earned_at) SELECT id, 'S1', 'manual-5', ?, 'available', 0 FROM accounts WHERE username = 'winner'`).run(toBaseUnits("5", 6).toString());
    const rewards = (await call("GET", "/api/me", undefined, as(winner))).body.rewards;
    const r30 = rewards.find((x: any) => x.goalId === "manual-30");
    const r5 = rewards.find((x: any) => x.goalId === "manual-5");
    assert.equal((await call("POST", `/api/rewards/${r30.id}/claim`, {}, as(winner))).status, 200);
    const blocked = await call("POST", `/api/rewards/${r5.id}/claim`, {}, as(winner));
    assert.equal(blocked.status, 429);
  });

  test("a failed send is parked for review, never retried automatically", async () => {
    const id = (db.prepare(`SELECT id FROM rewards WHERE goal_id = 'manual-30'`).get() as { id: number }).id;
    db.prepare(`UPDATE rewards SET status = 'approved' WHERE id = ?`).run(id);
    const failing: Transfer = {
      async prepare() {
        return { signature: "sig-123", send: async () => { throw new Error("rpc timeout"); } };
      },
    };
    await processNextPayout(db, failing);
    const row = db.prepare(`SELECT status, signature FROM rewards WHERE id = ?`).get(id) as { status: string; signature: string };
    assert.deepEqual({ ...row }, { status: "needs_review", signature: "sig-123" });
    assert.equal(await processNextPayout(db, dryRunTransfer()), false);
  });
});

describe("claim rules", () => {
  test("new accounts must wait before claiming", async () => {
    const strict = makeConfig({ minAccountAgeHoursToClaim: 24 });
    const db2 = openDb(":memory:");
    const srv = createApp(db2, strict).listen(0);
    await new Promise((r) => srv.once("listening", r));
    const oldBase = base;
    base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    try {
      const p = await signUp("newbie");
      await signUp("rival");
      await report("newbie", "rival", "newbie");
      const reward = (await call("GET", "/api/me", undefined, as(p))).body.rewards[0];
      const r = await call("POST", `/api/rewards/${reward.id}/claim`, {}, as(p));
      assert.equal(r.status, 400);
      assert.match(r.body.error, /after 24h/);
    } finally {
      base = oldBase;
      srv.close();
    }
  });
});

describe("ranked vs AI", () => {
  let p: Player;
  before(async () => {
    p = await signUp("solo");
  });
  const aiReport = (winner: string | null, extra: Record<string, unknown> = {}) =>
    gs("/api/gs/match-result", {
      matchId: `ai-${++matchSeq}-xxxxxxxx`,
      serverId: "vs-ai-1",
      mode: "ai",
      players: [{ username: "solo", leaver: false }],
      winner,
      turns: 9,
      durationSec: 300,
      ...extra,
    });

  test("a win against the AI counts on the AI ladder only and unlocks AI goals", async () => {
    const r = await aiReport("solo");
    assert.equal(r.body.ranked, true);
    const me = (await call("GET", "/api/me", undefined, as(p))).body;
    assert.equal(me.aiStats.wins, 1);
    assert.equal(me.aiStats.rating, 1200 + eloDelta(1200, 1400, 1));
    assert.equal(me.stats, null, "PvP stats untouched");
    assert.deepEqual(me.rewards.map((x: any) => x.goalId), ["ai-first-win"]);
    assert.equal(me.aiRankedLeftToday, 2);
  });

  test("losing to the AI, or leaving, is a ranked loss", async () => {
    assert.equal((await aiReport("Forge AI")).body.ranked, true);
    assert.equal((await aiReport("solo", { turns: 1, players: [{ username: "solo", leaver: true }] })).body.ranked, true);
    const me = (await call("GET", "/api/me", undefined, as(p))).body;
    assert.equal(me.aiStats.wins, 1);
    assert.equal(me.aiStats.losses, 2);
  });

  test("only MAX_AI_RANKED_PER_DAY AI games count per day", async () => {
    const r = await aiReport("solo");
    assert.equal(r.body.ranked, false);
    assert.match(r.body.note, /daily limit/);
  });

  test("AI leaderboard is separate from the PvP one", async () => {
    const ai = (await call("GET", "/api/leaderboard?ladder=ai")).body;
    assert.deepEqual(ai.rows.map((r: any) => r.username), ["solo"]);
    const pvp = (await call("GET", "/api/leaderboard")).body;
    assert.ok(!pvp.rows.some((r: any) => r.username === "solo"));
  });

  test("servers report their mode", async () => {
    await gs("/api/gs/heartbeat", { serverId: "vs-ai-1", address: "x:36745", mode: "ai", status: "waiting", players: [] });
    await gs("/api/gs/heartbeat", { serverId: "ranked-1", address: "x:36743", status: "waiting", players: [] });
    const servers = (await call("GET", "/api/servers")).body;
    assert.deepEqual(servers.map((s: any) => [s.id, s.mode]), [["ranked-1", "pvp"], ["vs-ai-1", "ai"]]);
  });
});
