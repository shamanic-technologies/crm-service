/**
 * CONNECTION TAGS — in what capacity does each human speak to us? (CONNECTION-TAGS-1017)
 *
 * Owner, 2026-10-17: crm-service is the fact registry; every human it holds carries at
 * least one of FOUR tags, up to all four at once:
 *
 *   personal_to_user           Personal, to the USER (who connected the account): a friend
 *                              writing to the user directly.
 *   personal_not_to_user       Personal, not to the user: a post in a community / hobby group,
 *                              a personal exchange the user is not the other side of.
 *   professional_to_brand      Professional, to the BRAND the CRM is linked to: a prospect, a
 *                              client, a user of what the brand sells.
 *   professional_not_to_brand  Professional, not to the brand: a supplier, the owner's other
 *                              activity, the accountant, an automated sender.
 *
 * "Personal" is judged against the USER (each personal tag names the user ids it is about);
 * "Professional" against the BRAND (the scope's brand). What lead-service or the dashboard
 * do with the tags is not crm-service's concern.
 *
 * Where each tag comes from, per presence of the person:
 *   - a direct conversation (Gmail, Matrix DM): Jev's four yes/no answers on it
 *     (people/relevance.ts), user = the account's owner(s);
 *   - a direct conversation holding no word a person wrote: personal_to_user (a DM to the
 *     user's own account, nothing says work);
 *   - a group the person WROTE in: Jev on their own posts in that group (people/group-tags.ts);
 *   - a group the person never wrote in: the group's own verdict, never "to user" (they never
 *     wrote to anybody);
 *   - a record of the brand's own tools (CRM, CSV, Stripe, auth provider, PostHog, our cold
 *     email, the Copilot, the API): professional_to_brand, no model;
 *   - an automated sender (Gmail-only, judged automated): professional_not_to_brand.
 * Tags of every presence are UNIONED: a friend who is also a client carries both.
 */

export const CONNECTION_TAGS = [
  "personal_to_user",
  "personal_not_to_user",
  "professional_to_brand",
  "professional_not_to_brand",
] as const;
export type ConnectionTag = (typeof CONNECTION_TAGS)[number];

/** A tag holds when Jev's yes-probability reaches this. */
export const TAG_MIN_PROBABILITY = 0.5;

export type TagScores = Record<ConnectionTag, number>;

const PERSONAL = new Set<ConnectionTag>(["personal_to_user", "personal_not_to_user"]);

/**
 * PURE: the tags a set of yes-probabilities states. Every tag at or above the bar; when none
 * reaches it, the most likely one (each judged item carries AT LEAST one tag, owner rule).
 */
export function tagsFromScores(scores: TagScores): ConnectionTag[] {
  const held = CONNECTION_TAGS.filter((t) => scores[t] >= TAG_MIN_PROBABILITY);
  if (held.length > 0) return held;
  return [CONNECTION_TAGS.reduce((best, t) => (scores[t] > scores[best] ? t : best), CONNECTION_TAGS[0])];
}

/** One judged item (a conversation, a group, a person's posts in a group). */
export interface TaggedItem {
  tags: ConnectionTag[];
  scores: TagScores | null;
  /** The user(s) the account belongs to: who "personal to user" is about. */
  userIds: string[];
}

export interface TagBasis {
  /** conversation | group_posts | group | direct_thread_no_words | source | evidence | automated_sender */
  kind: string;
  ref: string;
  probability: number | null;
}

export interface PersonConnectionTag {
  tag: ConnectionTag;
  /** Personal tags: the users it is about. Empty on professional tags. */
  userIds: string[];
  /** Professional tags: the brand it is judged against. Null on personal tags. */
  brandId: string | null;
  basis: TagBasis[];
}

/** Sources that are the brand's own tools: their records are the brand's business. */
export const BRAND_TOOL_SOURCES = new Set(["instantly", "gohighlevel", "posthog", "stripe", "clerk", "copilot", "api"]);
/** Merge evidence that is a record of the brand's business. */
export const BRAND_TOOL_EVIDENCE = new Set(["gohighlevel_contact", "csv_contact", "stripe_customer", "lead_pairing"]);

interface GroupLike {
  roomId: string;
  authoredCount: number;
}

export interface PersonLikeForTags {
  presences: { source: string; emails: string[]; sourceRef?: string; detail: Record<string, unknown> }[];
  evidence?: { kind: string; ref?: string }[];
}

export interface TagLookups {
  brandId: string;
  automated: boolean;
  /** `gmail:<addr>` / `matrix:<conversation id>` → its tags. A conversation with no words is `noWords`. */
  conversations: Map<string, TaggedItem | { noWords: true; userIds: string[] }>;
  /** `<roomId>` → the group's verdict (silent members inherit it). */
  groups: Map<string, TaggedItem>;
  /** `<roomId>|<contactId>` → the verdict on that member's own posts in the group. */
  posters: Map<string, TaggedItem>;
}

/** PURE: every tag the person earns, with what earned it. Empty = nothing judged yet. */
export function personConnectionTags(person: PersonLikeForTags, x: TagLookups): PersonConnectionTag[] {
  const out = new Map<ConnectionTag, PersonConnectionTag>();
  const add = (tag: ConnectionTag, userIds: string[], basis: TagBasis) => {
    const personal = PERSONAL.has(tag);
    const t = out.get(tag) ?? { tag, userIds: [], brandId: personal ? null : x.brandId, basis: [] };
    if (personal) for (const u of userIds) if (!t.userIds.includes(u)) t.userIds.push(u);
    if (!t.basis.some((b) => b.kind === basis.kind && b.ref === basis.ref)) t.basis.push(basis);
    out.set(tag, t);
  };
  const addItem = (item: TaggedItem, kind: string, ref: string, only?: (t: ConnectionTag) => ConnectionTag) => {
    for (const tag of item.tags) {
      const final = only ? only(tag) : tag;
      add(final, item.userIds, { kind, ref, probability: item.scores ? item.scores[tag] : null });
    }
  };

  for (const p of person.presences) {
    if (BRAND_TOOL_SOURCES.has(p.source)) {
      add("professional_to_brand", [], { kind: "source", ref: p.source, probability: null });
    }
    const keys: string[] = [];
    if (p.source === "gmail") for (const e of p.emails) keys.push(`gmail:${e}`);
    if (p.source === "matrix" && typeof p.detail.conversationId === "string") keys.push(`matrix:${p.detail.conversationId}`);
    for (const key of keys) {
      const v = x.conversations.get(key);
      if (!v) continue;
      if ("noWords" in v) add("personal_to_user", v.userIds, { kind: "direct_thread_no_words", ref: key, probability: null });
      else addItem(v, "conversation", key);
    }
    if (p.source === "matrix" && Array.isArray(p.detail.groups)) {
      const contactId = typeof p.detail.contactId === "string" ? p.detail.contactId : p.sourceRef;
      for (const g of p.detail.groups as GroupLike[]) {
        const posts = g.authoredCount > 0 && contactId ? x.posters.get(`${g.roomId}|${contactId}`) : undefined;
        if (posts) {
          addItem(posts, "group_posts", g.roomId);
          continue;
        }
        const group = x.groups.get(g.roomId);
        // A member is never "to user" through a group alone: they wrote to nobody.
        if (group) addItem(group, "group", g.roomId, (t) => (t === "personal_to_user" ? "personal_not_to_user" : t));
      }
    }
  }
  for (const e of person.evidence ?? []) {
    if (BRAND_TOOL_EVIDENCE.has(e.kind)) add("professional_to_brand", [], { kind: "evidence", ref: e.kind, probability: null });
  }
  if (x.automated) add("professional_not_to_brand", [], { kind: "automated_sender", ref: "sender_verdicts", probability: null });
  return CONNECTION_TAGS.filter((t) => out.has(t)).map((t) => out.get(t)!);
}

/** What the four yes/no questions ask, the same for a conversation, a group or a member's posts. */
export function tagQuestionText(tag: ConnectionTag, brandName: string): string {
  switch (tag) {
    case "personal_to_user":
      return (
        "Is the counterpart speaking PERSONALLY to the user (state.user, the person who connected this account): " +
        "family, a partner, a friend, a dating, health, housing or social exchange addressed to the user, not work?"
      );
    case "personal_not_to_user":
      return (
        "Is the counterpart speaking PERSONALLY but NOT to the user: chatter, news, jokes, community or hobby talk " +
        "posted to a group or to other people, where the user is not the one being addressed?"
      );
    case "professional_to_brand":
      return (
        `Is the counterpart speaking in a WORK role about what ${brandName} sells (state.brand and its offers): ` +
        `a prospect, a client, a user, or a partner who refers or resells clients to ${brandName}?`
      );
    case "professional_not_to_brand":
      return (
        `Is the counterpart speaking in a WORK role about something ${brandName} does NOT sell: a supplier, a tool or ` +
        "agency selling to the user, the user's other activities or employer, the accountant, a lawyer, a bank, a " +
        "mentor, an investor, the press, a recruiter or a candidate, a business pitch to a group?"
      );
  }
}
