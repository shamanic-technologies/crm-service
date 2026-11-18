/**
 * WHATSAPP-RELINK-1118: re-attach the past campaign WhatsApp sends to their written message (../lib/whatsapp/relink-sends.ts).
 *
 * DRY RUN BY DEFAULT: prints the plan per send, writes nothing anywhere. Inside the crm-service container:
 *   node dist/scripts/relink-whatsapp-sends.js                 the plan, every declared send
 *   node dist/scripts/relink-whatsapp-sends.js --apply --run <runId>   one send
 *   node dist/scripts/relink-whatsapp-sends.js --apply         every send planned `link`
 * Stops at the first unexpected answer (exit 1); a re-run only re-declares what is still without a consumption.
 */
import { asc, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { messageSentDeclarations } from "../db/schema.js";
import { STATUS } from "../lib/whatsapp/message-sent.js";
import { planRelink, relinkSend } from "../lib/whatsapp/relink-sends.js";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const onlyRun = args.includes("--run") ? args[args.indexOf("--run") + 1] : null;

const rows = await db
  .select({ runId: messageSentDeclarations.runId, leadId: messageSentDeclarations.leadId })
  .from(messageSentDeclarations)
  .where(eq(messageSentDeclarations.status, STATUS.DECLARED))
  .orderBy(asc(messageSentDeclarations.sentAt));
const sends = rows.filter((r): r is { runId: string; leadId: string } => !!r.leadId && (!onlyRun || r.runId === onlyRun));
const plans = await planRelink(sends);

const count = (v: string) => plans.filter((p) => p.verdict === v).length;
console.log(
  `${sends.length} declared send(s) read: ${count("link")} to link, ${count("already_consumes")} already consuming, ` +
    `${plans.length - count("link") - count("already_consumes")} left out. ${apply ? "APPLYING." : "DRY RUN: nothing written."}`,
);
for (const p of plans) console.log(`${p.verdict.padEnd(22)} run=${p.runId} lead=${p.leadId} sent=${p.sentAt ?? "-"}: ${p.detail}`);

let code = 0;
if (apply) {
  for (const p of plans.filter((x) => x.verdict === "link")) {
    try {
      const r = await relinkSend(p);
      console.log(`re-declared run=${r.runId} lead=${r.leadId}: recorded ${r.recordedCount}, already recorded ${r.alreadyRecordedCount}`);
    } catch (err) {
      console.error(`STOPPED at run=${p.runId}: ${(err as Error).message}`);
      code = 1;
      break;
    }
  }
}
process.exit(code);
