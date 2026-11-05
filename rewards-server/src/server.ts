import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { openDb } from "./db.js";
import { dryRunTransfer, recoverInterrupted, solanaTransfer, startPayoutWorker } from "./payouts.js";

const cfg = loadConfig();
const db = openDb(cfg.databasePath);
recoverInterrupted(db);

const transfer = cfg.payoutMode === "live" ? await solanaTransfer(cfg) : dryRunTransfer();
startPayoutWorker(db, transfer);

createApp(db, cfg).listen(cfg.port, cfg.host, () => {
  console.log(
    `rewards server on ${cfg.host}:${cfg.port} (season ${cfg.goals.season}, claims ${cfg.claimMode}, payouts ${cfg.payoutMode})`,
  );
});
