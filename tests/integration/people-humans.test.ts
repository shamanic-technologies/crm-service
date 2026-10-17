import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { contacts, ghlConnections, humanLinkStatements, people, peopleFacts } from "../../src/db/schema.js";
import { ensureScope, runScopeBuild } from "../../src/lib/people/build.js";

/**
 * The people build asks human-service "same human?" (people/humans.ts). Every
 * sibling is stubbed at `fetch`, human-service by an in-memory model of its
 * contract: proof keys (email / phone) given together merge fleet-wide, a link
 * with `orgId` holds for that org only, the human an org sees is named by its
 * oldest member.
 */
const RUN = !!process.env.CRM_TEST_DB;

const ORG = "a1b2c3d4-1111-4111-8111-000000000001";
const OTHER_ORG = "a1b2c3d4-1111-4111-8111-000000000009";
const BRAND = "a1b2c3d4-1111-4111-8111-000000000002";
const USER = "user-humans-1";

process.env.GOOGLE_SERVICE_URL = "http://google.test";
process.env.GOOGLE_SERVICE_API_KEY = "g";
process.env.INSTANTLY_SERVICE_URL = "http://instantly.test";
process.env.INSTANTLY_SERVICE_API_KEY = "i";
process.env.LEAD_SERVICE_URL = "http://lead.test";
process.env.LEAD_SERVICE_API_KEY = "l";
process.env.BRAND_SERVICE_URL = "http://brand.test";
process.env.BRAND_SERVICE_API_KEY = "b";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// ─── human-service, in memory ────────────────────────────────────────────────

interface Link {
  id: string;
  relation: "same" | "distinct";
  scope: "fleet" | "org";
  orgId: string | null;
  a: string;
  b: string;
  active: boolean;
}

class FakeHumans {
  n = 0;
  holder = new Map<string, string>();
  links: Link[] = [];
  facts: { factId: string; humanId: string; kind: string; statedByOrgId: string | null; withdrawn: boolean }[] = [];
  events: { id: string; type: string; orgId: string | null; humanIds: string[]; data: Record<string, unknown> }[] = [];
  down = false;
  id(prefix: string) {
    this.n++;
    return `${prefix}-1111-4111-8111-${String(this.n).padStart(12, "0")}`;
  }
  emit(type: string, orgId: string | null, humanIds: string[], data: Record<string, unknown> = {}) {
    this.events.push({ id: String(this.events.length + 1), type, orgId, humanIds, data });
  }
  component(h: string, orgId: string | null): string[] {
    const seen = new Set([h]);
    const queue = [h];
    while (queue.length) {
      const x = queue.shift()!;
      for (const l of this.links) {
        if (!l.active || l.relation !== "same" || (l.scope === "org" && l.orgId !== orgId)) continue;
        const other = l.a === x ? l.b : l.b === x ? l.a : null;
        if (other && !seen.has(other)) {
          seen.add(other);
          queue.push(other);
        }
      }
    }
    return [...seen];
  }
  /** Ids are minted in order: the smallest is the oldest member. */
  canonical(h: string, orgId: string | null) {
    return this.component(h, orgId).sort()[0];
  }
  /** The human holding an address, in ORG's view (null = nobody). */
  humanOfEmail(email: string) {
    const h = this.holder.get(`email:${email}`);
    return h ? this.canonical(h, ORG) : null;
  }
  resolve(b: { orgId?: string; emails?: string[]; phones?: string[]; create: boolean }) {
    const keys = [...(b.emails ?? []).map((e) => `email:${e.toLowerCase()}`), ...(b.phones ?? []).map((p) => `phone:${p}`)];
    const held = keys.map((k) => this.holder.get(k)).filter((x): x is string => !!x);
    const orgId = b.orgId ?? null;
    if (!b.create) {
      if (!held.length) return { humanId: null, atomicHumanId: null, created: false, mergedHumanIds: [], separatedHumanIds: [] };
      return { humanId: this.canonical(held[0], orgId), atomicHumanId: held[0], created: false, mergedHumanIds: [], separatedHumanIds: [] };
    }
    let anchor = held[0];
    let created = false;
    if (!anchor) {
      anchor = this.id("cccccccc");
      created = true;
      this.emit("human.created", null, [anchor]);
    }
    const merged: string[] = [];
    for (const h of held) {
      if (this.component(anchor, null).includes(h)) continue;
      const link: Link = { id: this.id("dddddddd"), relation: "same", scope: "fleet", orgId: null, a: anchor < h ? anchor : h, b: anchor < h ? h : anchor, active: true };
      this.links.push(link);
      merged.push(h);
      this.emit("human.linked", null, [link.a, link.b], { humanId: this.canonical(anchor, null), memberHumanIds: this.component(anchor, null) });
    }
    for (const k of keys) if (!this.holder.has(k)) this.holder.set(k, anchor);
    return { humanId: this.canonical(anchor, orgId), atomicHumanId: anchor, created, mergedHumanIds: merged, separatedHumanIds: [] };
  }
  handle(path: string, method: string, body: Record<string, unknown> | null, query: URLSearchParams): Response {
    if (this.down) return json({ error: "down" }, 503);
    if (method === "POST" && path === "/internal/human-identities/resolve") return json(this.resolve(body as never));
    if (method === "POST" && path === "/internal/human-identities/links") {
      const orgId = (body!.orgId as string | undefined) ?? null;
      if (!orgId && body!.relation === "same") return json({ error: "a fleet merge needs proof" }, 400);
      const [a, b] = (body!.humanIds as string[]).slice().sort();
      if (this.canonical(a, orgId) === this.canonical(b, orgId)) return json({ changed: false, link: null, humanIds: [this.canonical(a, orgId)] });
      const link: Link = { id: this.id("eeeeeeee"), relation: "same", scope: "org", orgId, a, b, active: true };
      this.links.push(link);
      this.emit("human.linked", orgId, [a, b], { humanId: this.canonical(a, orgId) });
      return json({ changed: true, link: { linkId: link.id, relation: "same", scope: "org", orgId, humanIds: [a, b] }, humanIds: [this.canonical(a, orgId)] });
    }
    const withdraw = path.match(/^\/internal\/human-identities\/links\/([^/]+)\/withdraw$/);
    if (method === "POST" && withdraw) {
      const link = this.links.find((l) => l.id === withdraw[1])!;
      link.active = false;
      this.emit("human.link_withdrawn", link.orgId, [link.a, link.b]);
      return json({ changed: true, link: { linkId: link.id } });
    }
    const fact = path.match(/^\/internal\/human-identities\/([^/]+)\/facts$/);
    if (method === "POST" && fact) {
      const f = { factId: this.id("ffffffff"), humanId: fact[1], kind: body!.kind as string, statedByOrgId: body!.statedByOrgId as string, withdrawn: false };
      this.facts.push(f);
      return json({ changed: true, fact: f });
    }
    const factWithdraw = path.match(/^\/internal\/human-identities\/facts\/([^/]+)\/withdraw$/);
    if (method === "POST" && factWithdraw) {
      this.facts.find((f) => f.factId === factWithdraw[1])!.withdrawn = true;
      return json({ changed: true, fact: {} });
    }
    if (method === "GET" && path === "/internal/human-identities/events") {
      const after = Number(query.get("after") ?? 0);
      const events = this.events.filter((e) => Number(e.id) > after);
      return json({ events, nextCursor: events.length ? events[events.length - 1].id : String(after), hasMore: false });
    }
    throw new Error(`unexpected human-service call ${method} ${path}`);
  }
}

let humans = new FakeHumans();
let leadPairings: unknown[] = [];
const WRITTEN = (email: string) => ({
  campaignId: "camp-h",
  instantlyCampaignId: "self:h",
  leadEmail: email,
  brandIds: [BRAND],
  firstSentAt: "2026-09-02T08:00:00.000Z",
  lastSentAt: "2026-09-02T08:00:00.000Z",
  engaged: false,
  unsubscribed: false,
  bounced: false,
  replied: false,
  clicked: false,
  firstRepliedAt: null,
  firstClickedAt: null,
  replyClassification: null,
  replyKind: null,
  disqualified: false,
});

function installFetchStub() {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    if (url.host === "human.test") {
      return humans.handle(url.pathname, method, init?.body ? JSON.parse(String(init.body)) : null, url.searchParams);
    }
    if (url.pathname.startsWith("/v1/runs") || url.pathname.startsWith("/v1/platform-runs")) {
      return json({ id: "run-" + Math.random().toString(16).slice(2) });
    }
    if (url.host === "google.test") return json({ error: "none", reason: "no_google_account_connected" }, 404);
    if (url.host === "brand.test") {
      if (url.pathname.endsWith("/offers")) return json({ offers: [] });
      if (url.pathname === "/orgs/brands") return json({ brands: [{ id: BRAND, name: "Brand", domain: "brand.com" }] });
      if (url.pathname.endsWith("/extracted-fields")) return json({ brandId: BRAND, fields: [] });
      return json({ brand: { id: BRAND, name: "Brand", domain: "brand.com", url: "https://brand.com" } });
    }
    if (url.host === "instantly.test") {
      if (url.pathname === "/internal/accounts") return json({ accounts: [] });
      if (url.pathname === "/orgs/written-to-leads") {
        const leads = [WRITTEN("lead@x.com")];
        return json({ success: true, count: leads.length, nextCursor: null, leads });
      }
      if (url.pathname === "/internal/outreach-facts") return json({ facts: [], nextCursor: "0", hasMore: false });
      return json({ error: "campaign_not_found" }, 404);
    }
    if (url.host === "lead.test") {
      if (url.pathname === "/orgs/leads") return json({ leads: [], total: 0 });
      if (url.pathname === "/orgs/leads/crm-pairings") {
        return json({ crmConnected: true, connection: null, pairings: leadPairings, nextOffset: null });
      }
    }
    throw new Error(`unexpected fetch ${url}`);
  });
}

async function wipe() {
  await db.execute(sql`TRUNCATE people_scopes, people, person_ids, person_id_aliases, person_merges, people_facts, lead_standing_observations, ghl_connections, contacts, human_keys, human_resolutions, human_link_statements, human_fact_statements, human_event_cursor, sender_verdicts, conversation_verdicts CASCADE`);
}

let ghlIds: Record<string, string> = {};

/** GoHighLevel: A (email + phone), B (email), C (email, Do Not Disturb). instantly: we wrote to lead@x.com. */
async function seed() {
  const [ghl] = await db
    .insert(ghlConnections)
    .values({ orgId: ORG, brandId: BRAND, locationId: "loc", createdByUserId: USER, lastSyncedAt: new Date() })
    .returning();
  const rows = await db
    .insert(contacts)
    .values(
      [
        { externalId: "ghl-a", primaryEmail: "a@x.com", phoneE164: "+33611111111", fullName: "Anna A", unsubscribed: false },
        { externalId: "ghl-b", primaryEmail: "b@y.com", phoneE164: null, fullName: "Ben B", unsubscribed: false },
        { externalId: "ghl-c", primaryEmail: "c@z.com", phoneE164: null, fullName: "Cleo C", unsubscribed: true },
      ].map((c) => ({ ...c, orgId: ORG, brandId: BRAND, source: "gohighlevel", rawAttributes: {}, sourceConnectionId: ghl.id })),
    )
    .returning();
  ghlIds = Object.fromEntries(rows.map((r) => [r.externalId!, r.id]));
}

const pairing = () => ({
  crmContact: { id: ghlIds["ghl-b"], email: "b@y.com", phone: null, fullName: "Ben B", company: null },
  pairing: { state: "paired", toConfirm: false, lead: { leadId: "lead-1", email: "lead@x.com", fullName: null, company: null } },
});

async function build() {
  const { scope } = await ensureScope(ORG, BRAND, USER);
  const r = await runScopeBuild(scope);
  expect(r.ok, r.error).toBe(true);
  return r.summary!;
}

const personOf = async (email: string) =>
  (await db.select().from(people).where(eq(people.brandId, BRAND))).find((p) => (p.emails as string[]).includes(email))!;

describe.skipIf(!RUN)("people x human-service: same human is human-service's call", () => {
  beforeEach(async () => {
    process.env.HUMAN_SERVICE_URL = "http://human.test";
    process.env.HUMAN_SERVICE_API_KEY = "h";
    humans = new FakeHumans();
    leadPairings = [];
    installFetchStub();
    await wipe();
    await seed();
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    delete process.env.HUMAN_SERVICE_URL;
    delete process.env.HUMAN_SERVICE_API_KEY;
    await wipe();
  });

  it("every person with an email / phone carries its human; a record's keys are stated together", async () => {
    const summary = await build();
    expect(summary.humanIdentity).toMatchObject({ status: "ok", peopleWithoutHumanId: 0, peopleWithHumanId: 4 });
    const a = await personOf("a@x.com");
    expect(a.humanId).toBe(humans.holder.get("email:a@x.com"));
    // GoHighLevel stated A's email and phone on ONE contact: one human holds both.
    expect(humans.holder.get("phone:+33611111111")).toBe(a.humanId);
    // A second build states nothing again.
    const calls = humans.n;
    const again = await build();
    expect(again.humanIdentity!.resolved).toBe(0);
    expect(humans.n).toBe(calls);
  });

  it("a lead-service pairing (a judgment) is an ORG-scoped link: one person for this org, two humans for the fleet", async () => {
    leadPairings = [pairing()];
    const summary = await build();
    expect(summary.humanIdentity).toMatchObject({ linksStated: 1, judgmentsLocal: 0 });
    const b = await personOf("b@y.com");
    expect((b.emails as string[]).sort()).toEqual(["b@y.com", "lead@x.com"]);
    expect(b.mergeEvidence).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "lead_pairing", heldBy: "human-service" })]));
    const [link] = humans.links.filter((l) => l.scope === "org");
    expect(link).toMatchObject({ orgId: ORG, active: true });
    const hb = humans.holder.get("email:b@y.com")!;
    const hl = humans.holder.get("email:lead@x.com")!;
    expect(humans.canonical(hb, ORG)).toBe(humans.canonical(hl, ORG));
    expect(humans.canonical(hb, OTHER_ORG)).not.toBe(humans.canonical(hl, OTHER_ORG));
    expect(humans.canonical(hb, null)).not.toBe(humans.canonical(hl, null));
    expect(b.humanId).toBe(humans.canonical(hb, ORG));

    // The pairing goes: the link is withdrawn, the two are two people again.
    leadPairings = [];
    const after = await build();
    expect(after.humanIdentity!.linksWithdrawn).toBe(1);
    expect(link.active).toBe(false);
    expect(((await personOf("b@y.com")).emails as string[])).toEqual(["b@y.com"]);
    const [statement] = await db.select().from(humanLinkStatements).where(eq(humanLinkStatements.brandId, BRAND));
    expect(statement.withdrawnAt).not.toBeNull();
  });

  it("a merge human-service makes elsewhere (another service's proof) reaches our people through its event feed", async () => {
    await build();
    expect((await personOf("a@x.com")).personKey).not.toBe((await personOf("b@y.com")).personKey);
    // Another service states A's and B's addresses on one contact: a fleet proof merge.
    humans.resolve({ emails: ["a@x.com", "b@y.com"], create: true });
    await build();
    const a = await personOf("a@x.com");
    expect((a.emails as string[]).sort()).toEqual(["a@x.com", "b@y.com"]);
    expect(a.humanId).toBe(humans.canonical(humans.holder.get("email:b@y.com")!, ORG));
  });

  it("a GoHighLevel Do Not Disturb is stated on the human, and withdrawn when the CRM drops it", async () => {
    await build();
    const hc = humans.holder.get("email:c@z.com");
    expect(humans.facts).toEqual([expect.objectContaining({ humanId: hc, kind: "do_not_contact", statedByOrgId: ORG, withdrawn: false })]);
    await build();
    expect(humans.facts).toHaveLength(1);
    await db.update(contacts).set({ unsubscribed: false }).where(and(eq(contacts.brandId, BRAND), eq(contacts.externalId, "ghl-c")));
    await build();
    expect(humans.facts[0].withdrawn).toBe(true);
  });

  it("the fact feed carries humanId; facts emitted before it was known are re-stated once", async () => {
    humans.down = true;
    const first = await build();
    expect(first.humanIdentity!.status).toBe("failed");
    const before = await db
      .select()
      .from(peopleFacts)
      .where(and(eq(peopleFacts.brandId, BRAND), eq(peopleFacts.live, true), sql`${peopleFacts.naturalKey} IS NOT NULL`));
    expect(before.length).toBeGreaterThan(0);
    expect(before.every((f) => f.humanId === null)).toBe(true);

    humans.down = false;
    const second = await build();
    expect(second.facts).toMatchObject({ status: "ok", humanIdentified: before.length });
    const live = await db
      .select()
      .from(peopleFacts)
      .where(and(eq(peopleFacts.brandId, BRAND), eq(peopleFacts.live, true), sql`${peopleFacts.naturalKey} IS NOT NULL`));
    expect(live.length).toBe(before.length);
    expect(live.every((f) => f.humanId !== null)).toBe(true);
    const third = await build();
    expect(third.facts).toMatchObject({ status: "ok", humanIdentified: 0, emitted: 0 });
  });

  it("HUMAN-ID-COVERAGE-1017: an imported CSV row nobody talked to is no person, but its fact names its human", async () => {
    await db.insert(contacts).values({
      orgId: ORG,
      brandId: BRAND,
      source: "csv",
      primaryEmail: "imported@csv.com",
      fullName: "Ida Imported",
      rawAttributes: {},
      unsubscribed: false,
    });
    const first = await build();
    expect(first.facts).toMatchObject({ status: "ok" });
    expect(await personOf("imported@csv.com")).toBeUndefined();
    const [fact] = await db
      .select()
      .from(peopleFacts)
      .where(and(eq(peopleFacts.brandId, BRAND), eq(peopleFacts.live, true), eq(peopleFacts.source, "csv")));
    expect(fact).toMatchObject({ type: "added_to_crm", subjectStandalone: true });
    expect(fact.humanId).toBe(humans.humanOfEmail("imported@csv.com"));
    const again = await build();
    expect(again.facts).toMatchObject({ emitted: 0, humanIdentified: 0 });
  });

  it("HUMAN-ID-COVERAGE-1017: a CSV fact emitted before its human was known is re-stated with it", async () => {
    await db.insert(contacts).values({ orgId: ORG, brandId: BRAND, source: "csv", primaryEmail: "late@csv.com", rawAttributes: {}, unsubscribed: false });
    humans.down = true;
    await build();
    humans.down = false;
    const second = await build();
    expect(second.facts!.status).toBe("ok");
    const live = await db
      .select()
      .from(peopleFacts)
      .where(and(eq(peopleFacts.brandId, BRAND), eq(peopleFacts.live, true), eq(peopleFacts.type, "added_to_crm"), eq(peopleFacts.source, "csv")));
    expect(live).toHaveLength(1);
    expect(live[0].humanId).toBe(humans.humanOfEmail("late@csv.com"));
  });

  it("human-service down: the build still runs, a pairing merges locally as before", async () => {
    humans.down = true;
    leadPairings = [pairing()];
    const summary = await build();
    expect(summary.humanIdentity).toMatchObject({ status: "failed", judgmentsLocal: 1, peopleWithHumanId: 0 });
    const b = await personOf("b@y.com");
    expect((b.emails as string[]).sort()).toEqual(["b@y.com", "lead@x.com"]);
    expect(b.mergeEvidence).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "lead_pairing", heldBy: "crm-service" })]));
  });
});
