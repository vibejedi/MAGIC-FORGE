# Ranked Forge

Ranked 1v1 multiplayer for [Forge](https://github.com/Card-Forge/forge) on a dedicated server you control. It has a public leaderboard and goals that pay out in a reward token on Solana.

> **Read [Before launch](#before-launch) first.** The code here works with any card pool. Stock Forge ships Magic: The Gathering card data, and that card data must not be used in a token-rewards launch.

```
 player's Forge client ──TCP 36743/36744──▶ forge-server (patched Forge, `forge server` mode)
        │                                         │  login check / heartbeat / match result
        │                                         │  (HMAC-signed, localhost)
        └── browser ──HTTPS──▶ Caddy ──▶ rewards-server (Node + SQLite)
                                                  │
                                                  └── SPL token transfers from a treasury hot wallet
```

## What's in this repo

| Path | What it is |
|---|---|
| `forge-server/patches/` | Patch to Forge (pinned to `forge-server/FORGE_COMMIT`) that adds a dedicated server mode. |
| `forge-server/Dockerfile` | Clones Forge at that commit, applies the patch, builds, and runs `forge server`. |
| `rewards-server/` | Wallet sign-in, login gate, match results, Elo leaderboard, goals, claims and payouts, plus the player web page. |
| `deploy/` | Docker Compose, Caddy (automatic HTTPS) and a one-time VPS setup script. |

## How a ranked match works

1. The player opens the website, connects a Solana wallet (Phantom/Solflare) and signs a message. This proves wallet ownership and moves no funds.
2. They pick a username once. It must be their **player name in Forge**.
3. They press **Play ranked**. This lets that username join a server for 15 minutes, **only from the IP address that pressed it**.
4. In Forge they choose *Online Multiplayer → Join* and enter a server address from the website. The server asks the rewards service whether the name and IP match. If not, the player is disconnected with an explanation.
5. Both players pick a deck and press Ready. The server starts the match itself; no player is the host.
6. When the game ends, the **server** reports the winner, turn count and anyone who disconnected. Players never report results, so a modified client can't fake a win.
7. The server restarts with an empty lobby once both players leave the result screen, or after 2 minutes.

### Anti-abuse rules (all in `.env`)

- A game counts as ranked only if it lasts at least `MIN_TURNS_FOR_RANKED` turns. Exception: a game where someone left.
- The same two players get at most `MAX_RANKED_PER_PAIR_PER_DAY` ranked games per 24h. This limits win-trading between friends or alt accounts.
- A player who disconnects and doesn't come back within 5 minutes forfeits; Forge hands their seat to the AI. If both leave, the match is void.
- Players can't rename themselves in the lobby. A disconnected player's seat can't be taken by someone else using their name, because reconnects also go through the IP check.
- Claims need an account at least `MIN_ACCOUNT_AGE_HOURS_TO_CLAIM` old, and are capped per account and globally per 24h.
- `CLAIM_MODE=manual` (the default) means you approve every payout yourself.
- A payout whose send fails or is interrupted is parked as `needs_review` and **never retried automatically**, so nobody gets paid twice.

What these rules don't stop: one person running two wallets from two networks and farming wins between them, up to the pair limit. Rating (Elo) makes that slow, and manual approval lets you spot it in `/api/admin/matches`. For larger reward pools, add stronger identity checks.

## Deploying on a VPS (e.g. Contabo)

Needs Ubuntu 22.04/24.04 and roughly 2 GB RAM per Forge server plus 1 GB. The Compose file runs two servers.

1. Point a domain at the VPS with an **A record only** (no AAAA). The IP check compares the address the website sees with the one Forge sees, and mixing IPv6 and IPv4 would make them differ.
2. On the VPS, as root:

   ```bash
   apt-get update && apt-get install -y git
   ```
   ```bash
   git clone <this repo> ranked-forge && cd ranked-forge
   ```
   ```bash
   ./deploy/install.sh play.yourdomain.com
   ```
   This installs Docker, opens ports 22, 80, 443 and 36743-36746 in the firewall, writes `deploy/.env` with fresh secrets, and builds and starts everything. The first build takes several minutes. Each Forge server needs about a minute to load its card data before it accepts players. Re-running it keeps your existing `.env`.
3. Edit `deploy/goals.json` for your goals and amounts and `deploy/.env` for limits, then apply the changes:

   ```bash
   cd deploy && docker compose up -d
   ```
4. Watch the logs:

   ```bash
   docker compose logs -f forge-1 rewards
   ```

To add a server, copy the `forge-2` block in `docker-compose.yml` with the next port, and open that port in `ufw`.

### Players' Forge version

Forge's network protocol changes between versions. Players should run Forge built from the **same commit** as the server (`forge-server/FORGE_COMMIT`); a different version gets a warning and may desync. The simplest route is to build the desktop client from the patched source and publish it. The patch doesn't change client behaviour. Forge is GPL-3.0, so publish the source alongside any client you distribute; this repo already contains it.

## Admin

All admin endpoints take `Authorization: Bearer $ADMIN_TOKEN`:

```bash
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" https://play.example.com/api/admin/claims?status=pending_approval
```
```bash
curl -s -X POST -H "Authorization: Bearer $ADMIN_TOKEN" https://play.example.com/api/admin/claims/42/approve
```
```bash
curl -s -X POST -H "Authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' -d '{"reason":"win trading"}' https://play.example.com/api/admin/claims/42/reject
```
```bash
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" https://play.example.com/api/admin/matches
```
```bash
curl -s -X POST -H "Authorization: Bearer $ADMIN_TOKEN" https://play.example.com/api/admin/accounts/someuser/ban
```

For a claim in `needs_review`, look up its `signature` on a Solana explorer, then resolve it. `true` means the transfer landed; `false` puts the claim back in the payout queue:

```bash
curl -s -X POST -H "Authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' -d '{"landed":true}' https://play.example.com/api/admin/claims/42/resolve
```

## Turning on real payouts

1. Create the reward token (an SPL mint) and a **separate treasury hot wallet**. Fund the wallet with only what you are prepared to lose, plus about 0.05 SOL. The treasury pays transaction fees and about 0.002 SOL rent for each player's first token account.
2. Test end to end on devnet first: set `SOLANA_RPC_URL=https://api.devnet.solana.com` and use a devnet mint.
3. Set `PAYOUT_MODE=live`, `REWARD_MINT`, `REWARD_DECIMALS` (must match the mint, which is checked at startup) and `TREASURY_SECRET_KEY`. Restart with `docker compose up -d`.
4. Keep `CLAIM_MODE=manual` until you trust the abuse limits.

## Before launch

- **Card content.** Stock Forge's card data (`forge-gui/res/cardsfolder`, editions and card images) is Magic: The Gathering intellectual property owned by Wizards of the Coast. Forge exists as a free, non-commercial fan project. A launch that pays out a token is commercial use, so it needs either an original card pool (Forge's engine loads card scripts, so mechanics can stay similar while names, text and art are your own) or a license from Wizards. The same applies to the project name: "Magic" is their trademark.
- **Token rewards law.** Paying out a token with market value for game results can raise securities, gambling/sweepstakes, money-transmission and tax questions depending on jurisdiction. Get advice from a lawyer who knows crypto before turning on live payouts.
- **GPL-3.0.** Forge is GPL-3.0. Running the modified server privately creates no obligation, but distributing a modified client does: publish its source.
- **Dependencies.** `npm audit` reports advisories in `@solana/web3.js` v1's transitive dependencies. Review them before going live.

## Development

```bash
cd rewards-server && npm install && npm test
```

Run the rewards service locally (dry-run payouts):

```bash
cd rewards-server && cp .env.example .env && cp config/goals.example.json config/goals.json
```
```bash
cd rewards-server && set -a && . ./.env && set +a && npx tsx src/server.ts
```

Build the patched Forge without Docker. This needs JDK 17+ and Maven:

```bash
forge-server/build-local.sh forge-src
```

`forge-gui-desktop/src/test/java/forge/net/DedicatedServerSmoke.java`, added by the patch, connects two scripted players to a running server and has one concede. Use it to check a server end to end.
