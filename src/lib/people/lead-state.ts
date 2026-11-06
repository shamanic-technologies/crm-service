/**
 * The ONE lead vocabulary, READ from lead-service (LEAD-GENERIC-1106, owner 2026-11-06). lead-service describes the
 * lead once (its `lead-state.ts`): Lifecycle (the one ladder), won / hot / lost (with the lost reasons), reachable,
 * conversation, fit, interest, client status and the next follow-up date. crm-service keeps NO copy of it: it reads
 * each Unibox row's `leadState` (`GET /orgs/leads/unibox`, every page) and relays it verbatim on the person. The only
 * word computed here is the person's `state` = the verdict lead-service served (`won` | `hot` | `lost`, else `open`:
 * lead-service's own word for a lead in none of them), never re-graded.
 *
 * What crm-service OWNS stays crm-service's (CRM facts, GoHighLevel stage meanings, label verdicts, Stripe states):
 * those only decide the state of someone lead-service serves no lead state for.
 *
 * Matching a person to a Unibox row: the row holding the person's lead (lead id, from lead-service's lead list),
 * else the first row of the person's human in lead-service's own order (most recent activity first). A Unibox row
 * is a human at a company; two rows of one human are lead-service's, never merged here.
 */
import { siblingGetOk, type SiblingIdentity } from "./siblings.js";
import { SwrCache } from "./swr.js";

/** lead-service's verdicts (won / hot / lost) + `open` (a lead in none of them, lead-service's word). */
export const LEAD_VERDICTS = ["won", "hot", "lost"] as const;
export type LeadVerdict = (typeof LEAD_VERDICTS)[number];
export const LEAD_STATES = [...LEAD_VERDICTS, "open"] as const;
export type LeadStateWord = (typeof LEAD_STATES)[number];

/** lead-service's `leadState`, verbatim (its schema `LeadState`). */
export interface LeadState {
  lifecycle: { key: string; rank: number; label: string } | null;
  won: boolean;
  hot: boolean;
  lost: { reasons: string[]; reachable: string | null; fit: string | null } | null;
  reachable: string;
  conversation: string;
  fit: string;
  fitNote: string | null;
  interest: string;
  clientStatus: string;
  nextFollowupAt: string | null;
  nextFollowupBasis: string | null;
}

/** PURE: the person's state word = lead-service's verdict, else `open`. */
export function leadStateWord(s: LeadState): LeadStateWord {
  if (s.won) return "won";
  if (s.hot) return "hot";
  if (s.lost) return "lost";
  return "open";
}

const str = (v: unknown) => typeof v === "string";
const strOrNull = (v: unknown) => v === null || typeof v === "string";

/** PURE: one served `leadState`, checked for every field we relay. Malformed fails loud (never a partial verdict). */
export function readLeadState(v: unknown, where: string): LeadState {
  const s = v as Record<string, unknown> | null;
  const lc = s?.lifecycle as Record<string, unknown> | null | undefined;
  const lost = s?.lost as Record<string, unknown> | null | undefined;
  const ok =
    !!s &&
    typeof s === "object" &&
    (lc === null || (!!lc && str(lc.key) && typeof lc.rank === "number" && str(lc.label))) &&
    typeof s.won === "boolean" &&
    typeof s.hot === "boolean" &&
    (lost === null || (!!lost && Array.isArray(lost.reasons) && lost.reasons.length > 0 && lost.reasons.every(str) && strOrNull(lost.reachable) && strOrNull(lost.fit))) &&
    str(s.reachable) &&
    str(s.conversation) &&
    str(s.fit) &&
    strOrNull(s.fitNote) &&
    str(s.interest) &&
    str(s.clientStatus) &&
    strOrNull(s.nextFollowupAt) &&
    strOrNull(s.nextFollowupBasis);
  if (!ok) throw new Error(`lead-service served an unreadable leadState (${where}): ${JSON.stringify(v).slice(0, 300)}`);
  return {
    lifecycle: lc ? { key: lc.key as string, rank: lc.rank as number, label: lc.label as string } : null,
    won: s!.won as boolean,
    hot: s!.hot as boolean,
    lost: lost ? { reasons: lost.reasons as string[], reachable: lost.reachable as string | null, fit: lost.fit as string | null } : null,
    reachable: s!.reachable as string,
    conversation: s!.conversation as string,
    fit: s!.fit as string,
    fitNote: s!.fitNote as string | null,
    interest: s!.interest as string,
    clientStatus: s!.clientStatus as string,
    nextFollowupAt: s!.nextFollowupAt as string | null,
    nextFollowupBasis: s!.nextFollowupBasis as string | null,
  };
}

/** One Unibox row's lead state, with what names the row. */
export interface UniboxLeadState {
  humanId: string;
  companyKey: string;
  relationKey: string | null;
  leadIds: string[];
  leadState: LeadState;
}

export interface BrandLeadStates {
  /** lead id → the first Unibox row (lead-service order) holding it. */
  byLeadId: Map<string, UniboxLeadState>;
  /** human id → the human's first Unibox row (lead-service order). */
  byHuman: Map<string, UniboxLeadState>;
  rows: number;
  readAt: string;
}

interface UniboxPageBody {
  rows: Array<{ humanId: string; companyKey: string; relationKey: string | null; leadIds: string[]; leadState?: unknown }>;
  nextCursor: string | null;
}

/** PURE: indexes the Unibox rows, in lead-service's order (first row of a key wins). */
export function indexLeadStates(rows: UniboxLeadState[]): Pick<BrandLeadStates, "byLeadId" | "byHuman" | "rows"> {
  const byLeadId = new Map<string, UniboxLeadState>();
  const byHuman = new Map<string, UniboxLeadState>();
  for (const r of rows) {
    for (const id of r.leadIds) if (!byLeadId.has(id)) byLeadId.set(id, r);
    if (!byHuman.has(r.humanId)) byHuman.set(r.humanId, r);
  }
  return { byLeadId, byHuman, rows: rows.length };
}

const UNIBOX_PAGE = 200;
const MAX_PAGES = 1000;

async function walkUnibox(identity: SiblingIdentity): Promise<BrandLeadStates> {
  const readAt = new Date().toISOString();
  const rows: UniboxLeadState[] = [];
  let cursor: string | null = null;
  for (let page = 0; ; page++) {
    if (page >= MAX_PAGES) throw new Error(`lead-service Unibox walk passed ${MAX_PAGES} pages for brand ${identity.brandId}`);
    const path: string =
      `/orgs/leads/unibox?brandId=${encodeURIComponent(identity.brandId)}&limit=${UNIBOX_PAGE}` +
      (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
    const body: UniboxPageBody = await siblingGetOk<UniboxPageBody>("lead", path, identity);
    if (!body || !Array.isArray(body.rows)) throw new Error("lead-service Unibox list answered without rows");
    for (const r of body.rows) {
      if (r.leadState === undefined) throw new Error(`lead-service Unibox row ${r.humanId}|${r.companyKey} carries no leadState`);
      rows.push({
        humanId: r.humanId,
        companyKey: r.companyKey,
        relationKey: r.relationKey ?? null,
        leadIds: r.leadIds ?? [],
        leadState: readLeadState(r.leadState, `row ${r.humanId}|${r.companyKey}`),
      });
    }
    if (!body.nextCursor) break;
    cursor = body.nextCursor;
  }
  return { ...indexLeadStates(rows), readAt };
}

/** A build reuses a walk this young (builds of one scope follow each other within minutes). */
export const LEAD_STATES_FRESH_MS = () => Number(process.env.PEOPLE_LEAD_STATES_FRESH_MS) || 5 * 60_000;
/** Past fresh and under this age, the last walk is served while ONE re-walk runs behind it. */
export const LEAD_STATES_MAX_STALE_MS = () => Number(process.env.PEOPLE_LEAD_STATES_MAX_STALE_MS) || 30 * 60_000;

const cache = new SwrCache<BrandLeadStates>("lead states", LEAD_STATES_FRESH_MS, LEAD_STATES_MAX_STALE_MS);

/** Every Unibox row's lead state for the brand, one shared walk per (org, brand). A failed walk is never cached. */
export function readBrandLeadStates(identity: SiblingIdentity): Promise<BrandLeadStates> {
  return cache.get(`${identity.orgId}:${identity.brandId}`, () => walkUnibox(identity));
}

/** Test seam. */
export function clearLeadStatesCache(): void {
  cache.clear();
}

/** How a person's lead state was found. */
export type LeadStateMatch = "lead_id" | "human_id";

/**
 * PURE: the person's Unibox lead state: the row holding one of their leads (in the order given: the person's
 * addresses' leads), else their human's first row. Null = lead-service serves no lead state for them.
 */
export function matchLeadState(
  leadIds: readonly string[],
  humanId: string | null,
  states: Pick<BrandLeadStates, "byLeadId" | "byHuman">,
): { row: UniboxLeadState; matchedBy: LeadStateMatch } | null {
  for (const id of leadIds) {
    const row = states.byLeadId.get(id);
    if (row) return { row, matchedBy: "lead_id" };
  }
  const row = humanId ? states.byHuman.get(humanId) : undefined;
  return row ? { row, matchedBy: "human_id" } : null;
}
