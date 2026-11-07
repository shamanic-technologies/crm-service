/**
 * CLIENT-SATISFIED-1107 — the outcome « Client Satisfied » (features-service catalogue key `client_satisfied`: "A paying
 * client writes us a positive message.", lifecycle rung paid_client): per brand, every person who is a PAYING client of
 * the brand AND wrote it a positive message, any channel.
 *
 * - **Paying client** = a fact the fleet already holds, read off the live people fact feed exactly as the Outcomes
 *   `sale` step reads it (a CRM deal won `sale`, a Stripe `payment` that STANDS) plus the CRM's own `client` label
 *   (GoHighLevel stage / tag judged `client`). Since = their earliest dated such fact; all undated = a client, any date.
 * - **A message they wrote** = a live `message_in` fact owned by them (Gmail, WhatsApp, LinkedIn, Telegram...: every
 *   conversation channel the feed carries; one path, no channel case), dated at or after they became a client. A word
 *   written BEFORE paying is a positive reply, not a satisfied client.
 * - **Positive** = Jev's verdict (`positive | neutral | negative`, P(positive) >= 0.5), judged ONCE per message (keyed
 *   on the fact's natural key + its text hash: a message whose text moves is judged again), recorded in
 *   `client_message_verdicts` with the message excerpt, run and model: the stored evidence of every reach. Politeness
 *   alone ("ok", "thanks") is neutral. A message holding no words is recorded `no_words` with no call.
 * - **One path, past and future**: every pass reads every unjudged message of every paying client, history included
 *   (the backfill is the first pass).
 * - **Cost**: chat-service `POST /orgs/judgments` (Jev, input tokens only), org-billed to the scope's org + creator, on
 *   ONE org run per scope pass (`people.client-satisfaction`), opened only when something is to be judged. crm-service
 *   declares no cost of its own (chat-service declares it on the run).
 * - The outcome is READ (outcomes.ts `client_satisfied` step) with the paying condition re-checked at read: a refund
 *   that takes the client status away takes the outcome away.
 */
import { createHash } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import { db } from "../../db/index.js";
import { peopleScopes, type PeopleScope } from "../../db/schema.js";
import { judgeChoices, type ChoiceQuestion, type JudgmentsResult } from "../judgments-client.js";
import { createRun, updateRun } from "../runs-client.js";
import { payingClientsSql } from "./outcomes.js";

export const POSITIVE_THRESHOLD = 0.5;
const MESSAGE_CHARS = 1500;
const CONTEXT_CHARS = 600;
const EXCERPT_CHARS = 500;
const PER_CALL = 20;
const LOG = "[crm-service][client-satisfaction]";

async function rows<T>(query: SQL): Promise<T[]> {
  return (await db.execute(query)) as unknown as T[];
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
/** PURE: at most `max` characters, cut on a code point and well-formed (Jev refuses a lone surrogate). */
export function clipText(s: string, max: number): string {
  const chars = Array.from(s.replace(LONE_SURROGATE, "�"));
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : chars.join("");
}

/** PURE: the text's hash (a message whose words move is judged again). */
export const textHash = (text: string) => createHash("md5").update(text).digest("hex");

/** PURE: a message holding at least one letter or digit says something Jev can read. */
export const hasWords = (text: string) => /[\p{L}\p{N}]/u.test(text);

/** One message a paying client wrote the brand, not judged yet (or its text moved). */
export interface ClientMessage {
  naturalKey: string;
  personKey: string;
  source: string;
  channel: string | null;
  at: string | null;
  text: string;
  /** The message just before it in the person's exchange with the brand (either direction), for context. */
  previous: { fromUs: boolean; text: string } | null;
}

export const QUESTION: Omit<ChoiceQuestion, "instructions"> & { instructions: string } = {
  type: "choice",
  instructions:
    "The writer is a PAYING CLIENT of the brand. Judge ONE message they wrote to the brand (its id names it in `messages`; " +
    "`previous` is the message just before it in the same exchange, for context only, `fromUs` = the brand wrote it). " +
    "Is this message positive about the brand: its product, its service, the people or the results it brought them?",
  criteria: {
    positive:
      "The client expresses satisfaction with the brand: praise, enthusiasm, a good result, gratitude for something the brand " +
      "did or delivered, or wanting more of it (renewing, buying more, recommending it).",
    neutral:
      "No feeling about the brand: a question, logistics, a date, a code, a file, a request, or plain politeness on its own " +
      "(\"ok\", \"thanks\", \"got it\", a greeting).",
    negative:
      "The client complains, is frustrated or disappointed, reports a problem or a bad result, or asks for a refund or to stop.",
  },
};

/** PURE: what Jev reads and is asked for one batch of one person's messages (`m0`.. keys, in order). */
export function judgmentInput(messages: ClientMessage[]): { state: unknown; questions: Record<string, ChoiceQuestion> } {
  const state = {
    messages: messages.map((m, i) => ({
      id: `m${i}`,
      at: m.at,
      channel: m.channel ?? m.source,
      previous: m.previous ? { fromUs: m.previous.fromUs, text: clipText(m.previous.text, CONTEXT_CHARS) } : null,
      text: clipText(m.text, MESSAGE_CHARS),
    })),
  };
  const questions = Object.fromEntries(
    messages.map((_, i) => [`m${i}`, { ...QUESTION, instructions: `${QUESTION.instructions} Judge message id m${i} only.` }]),
  );
  return { state, questions };
}

export interface Verdict {
  verdict: "positive" | "neutral" | "negative";
  pPositive: number;
  probabilities: Record<string, number>;
}

/** PURE: one answer's verdict: positive only at P(positive) >= 0.5, else the likelier of neutral / negative. */
export function verdictOf(probabilities: Record<string, number>): Verdict {
  const p = probabilities.positive ?? 0;
  if (p >= POSITIVE_THRESHOLD) return { verdict: "positive", pPositive: p, probabilities };
  const neg = probabilities.negative ?? 0;
  const neu = probabilities.neutral ?? 0;
  return { verdict: neg > neu ? "negative" : "neutral", pPositive: p, probabilities };
}

/** PURE: group a person's messages into Jev calls of at most PER_CALL, oldest first, one person per call. */
export function batchesOf(messages: ClientMessage[]): ClientMessage[][] {
  const byPerson = new Map<string, ClientMessage[]>();
  for (const m of messages) (byPerson.get(m.personKey) ?? byPerson.set(m.personKey, []).get(m.personKey)!).push(m);
  const out: ClientMessage[][] = [];
  for (const list of byPerson.values()) {
    for (let i = 0; i < list.length; i += PER_CALL) out.push(list.slice(i, i + PER_CALL));
  }
  return out;
}

/** Every message a paying client wrote the brand since becoming one, not judged on its current text yet. */
export async function readUnjudgedClientMessages(orgId: string, brandId: string): Promise<ClientMessage[]> {
  const found = await rows<{
    natural_key: string;
    person_key: string;
    source: string;
    channel: string | null;
    at: string | Date | null;
    text: string | null;
    prev_type: string | null;
    prev_text: string | null;
  }>(sql`
    WITH client AS (${payingClientsSql(orgId, brandId)}),
    m AS (
      SELECT m.natural_key, m.owner_person_key, m.source, m.payload->>'channel' AS channel, m.occurred_at,
             COALESCE(m.payload->>'text', '') AS text
      FROM people_facts m JOIN client c ON c.owner_person_key = m.owner_person_key
      WHERE m.org_id = ${orgId} AND m.brand_id = ${brandId}
        AND m.live AND m.type = 'message_in' AND m.natural_key IS NOT NULL
        AND (c.client_since IS NULL OR m.occurred_at >= c.client_since)
    )
    SELECT m.natural_key, m.owner_person_key AS person_key, m.source, m.channel, m.occurred_at AS at, m.text,
           prev.type AS prev_type, prev.text AS prev_text
    FROM m
    LEFT JOIN client_message_verdicts v
      ON v.org_id = ${orgId} AND v.brand_id = ${brandId} AND v.natural_key = m.natural_key AND v.text_hash = md5(m.text)
    LEFT JOIN LATERAL (
      SELECT p.type, COALESCE(p.payload->>'text', '') AS text FROM people_facts p
      WHERE p.org_id = ${orgId} AND p.brand_id = ${brandId} AND p.live AND p.owner_person_key = m.owner_person_key
        AND p.type IN ('message_in', 'message_out') AND p.occurred_at < m.occurred_at
      ORDER BY p.occurred_at DESC LIMIT 1
    ) prev ON true
    WHERE v.id IS NULL
    ORDER BY m.owner_person_key, m.occurred_at ASC NULLS LAST, m.natural_key
  `);
  return found.map((r) => ({
    naturalKey: r.natural_key,
    personKey: r.person_key,
    source: r.source,
    channel: r.channel,
    at: r.at === null ? null : new Date(r.at).toISOString(),
    text: r.text ?? "",
    previous: r.prev_type ? { fromUs: r.prev_type === "message_out", text: r.prev_text ?? "" } : null,
  }));
}

async function record(orgId: string, brandId: string, m: ClientMessage, v: Verdict | null, model: string | null, runId: string | null): Promise<void> {
  const values = {
    verdict: v ? v.verdict : "no_words",
    pPositive: v ? v.pPositive : 0,
    probabilities: v ? JSON.stringify(v.probabilities) : null,
  };
  await db.execute(sql`
    INSERT INTO client_message_verdicts
      (org_id, brand_id, natural_key, text_hash, verdict, p_positive, probabilities, model, run_id, source, message_at, excerpt, judged_at)
    VALUES (${orgId}, ${brandId}, ${m.naturalKey}, ${textHash(m.text)}, ${values.verdict}, ${values.pPositive},
            ${values.probabilities}::jsonb, ${model}, ${runId}, ${m.source}, ${m.at}, ${clipText(m.text, EXCERPT_CHARS)}, now())
    ON CONFLICT (org_id, brand_id, natural_key) DO UPDATE SET
      text_hash = excluded.text_hash, verdict = excluded.verdict, p_positive = excluded.p_positive,
      probabilities = excluded.probabilities, model = excluded.model, run_id = excluded.run_id, source = excluded.source,
      message_at = excluded.message_at, excerpt = excluded.excerpt, judged_at = excluded.judged_at
  `);
}

export interface ScopeJudgeResult {
  scopeId: string;
  brandId: string;
  candidates: number;
  judged: number;
  positive: number;
  noWords: number;
  failedCalls: number;
  runId: string | null;
  error?: string;
}

/** The Jev call, injectable for tests. */
export type Judge = typeof judgeChoices;

/** One scope: judge every unjudged message of its paying clients on ONE org run (opened only when needed). */
export async function judgeScope(scope: PeopleScope, judge: Judge = judgeChoices): Promise<ScopeJudgeResult> {
  const { orgId, brandId } = scope;
  const result: ScopeJudgeResult = { scopeId: scope.id, brandId, candidates: 0, judged: 0, positive: 0, noWords: 0, failedCalls: 0, runId: null };
  const messages = await readUnjudgedClientMessages(orgId, brandId);
  result.candidates = messages.length;
  const silent = messages.filter((m) => !hasWords(m.text));
  for (const m of silent) await record(orgId, brandId, m, null, null, null);
  result.noWords = silent.length;
  const toJudge = messages.filter((m) => hasWords(m.text));
  if (toJudge.length === 0) return result;

  const identity = { orgId, userId: scope.createdByUserId };
  const run = await createRun({ ...identity, brandIds: [brandId], serviceName: "crm-service", taskName: "people.client-satisfaction" });
  result.runId = run.id;
  try {
    for (const batch of batchesOf(toJudge)) {
      const { state, questions } = judgmentInput(batch);
      let answer: JudgmentsResult;
      try {
        answer = await judge(state, questions, { ...identity, runId: run.id, brandIds: [brandId] });
      } catch (err) {
        // Jev down / refused: nothing recorded for this batch, asked again next pass.
        result.failedCalls++;
        console.error(`${LOG} judgment failed scope=${scope.id} person=${batch[0].personKey}:`, (err as Error).message);
        continue;
      }
      for (const [i, m] of batch.entries()) {
        const a = answer.answers[`m${i}`];
        if (!a || a.type !== "choice" || !a.probabilities) {
          result.failedCalls++;
          console.error(`${LOG} answer m${i} missing scope=${scope.id} message=${m.naturalKey}`);
          continue;
        }
        const v = verdictOf(a.probabilities);
        await record(orgId, brandId, m, v, answer.model, run.id);
        result.judged++;
        if (v.verdict === "positive") result.positive++;
      }
    }
    await updateRun(run.id, result.failedCalls > 0 && result.judged === 0 ? "failed" : "completed", identity);
  } catch (err) {
    await updateRun(run.id, "failed", identity).catch((e) => console.error(`${LOG} failed to close run ${run.id}:`, e));
    throw err;
  }
  return result;
}

let running = false;

/** One pass over every people scope; one failing scope does not stop the others. Null when a pass already runs. */
export async function runClientSatisfactionPass(judge: Judge = judgeChoices): Promise<ScopeJudgeResult[] | null> {
  if (running) return null;
  running = true;
  try {
    const scopes = await db.select().from(peopleScopes);
    const out: ScopeJudgeResult[] = [];
    for (const scope of scopes) {
      try {
        const r = await judgeScope(scope, judge);
        out.push(r);
        if (r.candidates > 0) {
          console.log(
            `${LOG} scope=${scope.id} brand=${scope.brandId} candidates=${r.candidates} judged=${r.judged} positive=${r.positive} noWords=${r.noWords} failedCalls=${r.failedCalls}`,
          );
        }
      } catch (err) {
        console.error(`${LOG} scope=${scope.id} failed:`, err);
        out.push({ scopeId: scope.id, brandId: scope.brandId, candidates: 0, judged: 0, positive: 0, noWords: 0, failedCalls: 0, runId: null, error: (err as Error).message });
      }
    }
    return out;
  } finally {
    running = false;
  }
}

const INTERVAL_MS = () => Number(process.env.CLIENT_SATISFACTION_INTERVAL_MS) || 10 * 60_000;

/** Every 10 min (first pass 2 min after boot); `CLIENT_SATISFACTION=off` stops it. */
export function startClientSatisfactionWatch(): void {
  if (process.env.CLIENT_SATISFACTION === "off") {
    console.log(`${LOG} off (CLIENT_SATISFACTION=off)`);
    return;
  }
  const tick = () => {
    runClientSatisfactionPass().catch((err) => console.error(`${LOG} pass crashed:`, err));
  };
  setTimeout(() => {
    tick();
    setInterval(tick, INTERVAL_MS()).unref();
  }, 120_000).unref();
}
