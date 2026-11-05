import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import http, { type Server } from "node:http";
import net, { type AddressInfo } from "node:net";
import bs58 from "bs58";
import { createApp } from "../src/app.js";
import { signServerRequest } from "../src/auth.js";
import { type Config, validateGoals } from "../src/config.js";
import { type DB, openDb } from "../src/db.js";
import { attachStreamUpgrade } from "../src/stream.js";

const GS_SECRET = "g".repeat(40);
const STREAM_SECRET = "t".repeat(40);
const PORT_BASE = 46080;

const cfg: Config = {
  host: "127.0.0.1", port: 0, trustProxy: false, publicOrigin: "http://play.test",
  databasePath: ":memory:", goals: validateGoals({ season: "S1", goals: [] }),
  gameServerSecret: GS_SECRET, adminToken: "a".repeat(40),
  minTurnsForRanked: 4, maxRankedPerPairPerDay: 2, maxAiRankedPerDay: 5, aiRating: 1400,
  armTtlMinutes: 15, minAccountAgeHoursToClaim: 0, claimMode: "manual", payoutMode: "dry-run",
  rewardSymbol: "RWD", rewardDecimals: 6, accountDailyCap: "40", globalDailyCap: "1000",
  solanaRpcUrl: "", rewardMint: "", treasurySecretKey: "",
  streamSlots: 2, streamSecret: STREAM_SECRET, streamSubnetPrefix: "172.30.0.", streamPortBase: PORT_BASE,
  streamSessionMinutes: 90, streamAllowedUsers: ["alice", "bob", "carol"],
};

let db: DB;
let server: Server;
let base: string;
const upstreams: net.Server[] = [];
const upstreamSeen: string[] = [];

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(base + path, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json, setCookie: res.headers.get("set-cookie") };
}

async function signUp(name: string) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const wallet = bs58.encode(Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url"));
  const { body } = await call("POST", "/api/auth/nonce", { wallet });
  const sig = bs58.encode(sign(null, Buffer.from(body.message), privateKey));
  const token = (await call("POST", "/api/auth/verify", { wallet, message: body.message, signature: sig })).body.token;
  await call("POST", "/api/me/username", { username: name }, { authorization: `Bearer ${token}` });
  return { authorization: `Bearer ${token}` };
}
const cookieOf = (setCookie: string | null) => setCookie!.split(";")[0];

function signedAssignment(slot: number, secret = STREAM_SECRET) {
  const raw = JSON.stringify({ slot });
  const ts = String(Math.floor(Date.now() / 1000));
  return fetch(base + "/api/stream/assignment", {
    method: "POST",
    headers: { "content-type": "application/json", "x-timestamp": ts, "x-signature": signServerRequest(secret, ts, raw) },
    body: raw,
  });
}

/** Raw WebSocket-style upgrade through the proxy; resolves with the socket and first response chunk. */
function upgrade(path: string, cookie?: string): Promise<{ socket: net.Socket; head: string }> {
  return new Promise((resolve, reject) => {
    const port = (server.address() as AddressInfo).port;
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: play.test\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          (cookie ? `Cookie: ${cookie}\r\n` : "") + "\r\n",
      );
    });
    socket.once("data", (d) => resolve({ socket, head: d.toString() }));
    socket.once("error", reject);
  });
}

before(async () => {
  // Fake noVNC/websockify for each slot: answers HTTP with the path it saw; upgrades get a 101.
  for (let slot = 1; slot <= 2; slot++) {
    const up = net.createServer((s) => {
      s.once("data", (d) => {
        const line = d.toString().split("\r\n")[0];
        upstreamSeen.push(`slot${slot} ${line}`);
        if (/upgrade: websocket/i.test(d.toString())) {
          s.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
        } else {
          const body = `novnc slot ${slot} ${line.split(" ")[1]}`;
          s.end(`HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`);
        }
      });
    });
    await new Promise<void>((r) => up.listen(PORT_BASE + slot, "127.0.0.1", r));
    upstreams.push(up);
  }
  db = openDb(":memory:");
  server = createApp(db, cfg).listen(0, "127.0.0.1");
  attachStreamUpgrade(server, db, cfg, 100);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.close();
  upstreams.forEach((u) => u.close());
});

describe("browser play", () => {
  let alice: Record<string, string>;
  let aliceCookie = "";

  test("an empty invite list lets nobody in; * lets everyone in", async () => {
    const { streamAllowed } = await import("../src/stream.js");
    assert.equal(streamAllowed({ ...cfg, streamAllowedUsers: [] }, "alice"), false);
    assert.equal(streamAllowed({ ...cfg, streamAllowedUsers: ["*"] }, "anyone"), true);
    assert.equal(streamAllowed({ ...cfg, streamAllowedUsers: ["alice"] }, "ALICE"), true);
    assert.equal(streamAllowed({ ...cfg, streamAllowedUsers: ["*"], streamSlots: 0 }, "alice"), false);
  });

  test("only invited players with a username can start", async () => {
    alice = await signUp("alice");
    const mallory = await signUp("mallory");
    assert.equal((await call("POST", "/api/stream/start", {}, mallory)).status, 403);
    const st = (await call("GET", "/api/stream", undefined, mallory)).body;
    assert.deepEqual({ allowed: st.allowed, free: st.free }, { allowed: false, free: 2 });
  });

  test("start assigns a slot, sets an HttpOnly cookie and arms the slot IP", async () => {
    const r = await call("POST", "/api/stream/start", {}, alice);
    assert.equal(r.status, 200);
    assert.equal(r.body.slot, 1);
    assert.match(r.body.url, /^\/stream\/1\/vnc\.html\?.*path=stream\/1\/websockify/);
    assert.match(r.setCookie!, /mc_stream=.+; Path=\/stream\/; HttpOnly; SameSite=Strict/);
    aliceCookie = cookieOf(r.setCookie);
    const raw = JSON.stringify({ username: "alice", ip: "172.30.0.11" });
    const ts = String(Math.floor(Date.now() / 1000));
    const gate = await fetch(base + "/api/gs/login-check", {
      method: "POST",
      headers: { "content-type": "application/json", "x-timestamp": ts, "x-signature": signServerRequest(GS_SECRET, ts, raw) },
      body: raw,
    });
    assert.equal(((await gate.json()) as any).ok, true);
  });

  test("the launcher sees the assignment only with the stream secret", async () => {
    const r = await signedAssignment(1);
    assert.equal(r.status, 200);
    assert.equal(((await r.json()) as any).username, "alice");
    assert.equal((await signedAssignment(1, GS_SECRET)).status, 401);
    assert.equal(((await (await signedAssignment(2)).json()) as any).username, null);
  });

  test("the noVNC page is proxied only with the right cookie, prefix stripped", async () => {
    const ok = await call("GET", "/stream/1/vnc.html?autoconnect=1", undefined, { cookie: aliceCookie });
    assert.equal(ok.status, 200);
    assert.equal(ok.body, "novnc slot 1 /vnc.html?autoconnect=1");
    assert.equal((await call("GET", "/stream/1/vnc.html")).status, 403);
    assert.equal((await call("GET", "/stream/2/vnc.html", undefined, { cookie: aliceCookie })).status, 403);
  });

  test("websocket upgrades need the cookie and are cut when the session ends", async () => {
    const denied = await upgrade("/stream/1/websockify");
    assert.match(denied.head, /^HTTP\/1.1 403/);
    denied.socket.destroy();

    const { socket, head } = await upgrade("/stream/1/websockify", aliceCookie);
    assert.match(head, /^HTTP\/1.1 101/);
    assert.ok(upstreamSeen.includes("slot1 GET /websockify HTTP/1.1"));
    const closed = new Promise((r) => socket.once("close", r));
    assert.equal((await call("POST", "/api/stream/stop", {}, alice)).status, 200);
    await closed; // the sweep (100 ms in tests) disconnects the viewer
    assert.equal((await call("GET", "/stream/1/vnc.html", undefined, { cookie: aliceCookie })).status, 403);
  });

  test("seats run out, and a player keeps their slot when restarting", async () => {
    const bob = await signUp("bob");
    const carol = await signUp("carol");
    const a = await call("POST", "/api/stream/start", {}, alice);
    const b = await call("POST", "/api/stream/start", {}, bob);
    assert.deepEqual([a.body.slot, b.body.slot], [1, 2]);
    assert.equal((await call("POST", "/api/stream/start", {}, carol)).status, 429);
    const again = await call("POST", "/api/stream/start", {}, alice);
    assert.equal(again.body.slot, 1);
    // renewing issues a new ticket; the old cookie stops working
    assert.equal((await call("GET", "/stream/1/vnc.html", undefined, { cookie: cookieOf(a.setCookie) })).status, 403);
    assert.equal((await call("GET", "/stream/1/vnc.html", undefined, { cookie: cookieOf(again.setCookie) })).status, 200);
  });

  test("an expired session frees the slot and the player can start again elsewhere", async () => {
    db.prepare(`UPDATE stream_sessions SET expires_at = 0`).run();
    const carol = await signUp("carol2");
    void carol;
    const alice2 = await call("POST", "/api/stream/start", {}, alice);
    assert.equal(alice2.status, 200);
    const bob2 = await call("GET", "/api/stream", undefined, alice);
    assert.equal(bob2.body.session.slot, alice2.body.slot);
  });
});
