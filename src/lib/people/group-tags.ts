/**
 * CONNECTION TAGS of the brand's messaging GROUPS (CONNECTION-TAGS-1017).
 *
 * A group (WhatsApp, LinkedIn, Telegram) is no conversation with the user, but its members are
 * humans of the registry and each needs its tags. Two Jev judgments, recorded in
 * `conversation_verdicts` beside the direct threads (source `matrix_group`):
 *
 *   - `group:<roomId>`: the GROUP itself (name, size, its latest messages): personal or work,
 *     about the brand or not. Every member who never wrote inherits it, never "to user"
 *     (people/connection-tags.ts). Re-judged when it is renamed or gets new messages.
 *   - `group:<roomId>|<contactId>`: ONE MEMBER's own posts in it (first 10 + last 20), each
 *     saying whether it replies to, or mentions, the user. Re-judged when they post again.
 *
 * Prod 2026-10-17 (Distribute.you): 132 groups, 757 member x group pairs who ever wrote,
 * 3,867 group messages in all, so a full pass is ~900 Jev calls once and a handful after.
 */
import { and, eq, gt, inArray } from "drizzle-orm";
import { db } from "../../db/index.js";
import { conversationVerdicts, matrixConnections, matrixGroupMembers, matrixGroups, matrixRawEvents } from "../../db/schema.js";
import type { ChatTrackingHeaders } from "../chat-client.js";
import { judgeQuestions, type NoulQuestion } from "../judgments-client.js";
import type { MatrixEvent } from "../matrix/client.js";
import { compareEvents, humanText } from "../matrix/events.js";
import { accountUserView, userIdsOf, type AccountUsers, type AccountUserView } from "./account-users.js";
import { CONNECTION_TAGS, tagQuestionText, tagsFromScores, type ConnectionTag, type TaggedItem, type TagScores } from "./connection-tags.js";
import { clip, readTagScores, storedVerdicts, threadWindow, type BrandContext, type PersonView } from "./relevance.js";
import { mapLimit, type SiblingIdentity } from "./siblings.js";

const CONCURRENCY = 4;
const GROUP_SAMPLE = 30;

export interface GroupLine {
  at: string;
  /** user = one of the brand's own accounts; member = anyone else. */
  from: "user" | "member";
  sender: string;
  text: string;
  repliesToUser: boolean;
  mentionsUser: boolean;
}

/** PURE: a group's messages as lines, human words only, edits folded away, oldest first. */
export function groupLines(events: MatrixEvent[], ownMxids: Set<string>): GroupLine[] {
  const messages = events.filter((e) => e.type === "m.room.message").sort(compareEvents);
  const senderOf = new Map(messages.map((m) => [m.event_id, m.sender]));
  const out: GroupLine[] = [];
  for (const m of messages) {
    const rel = m.content?.["m.relates_to"] as { rel_type?: unknown; ["m.in_reply_to"]?: { event_id?: unknown } } | undefined;
    if (rel?.rel_type === "m.replace") continue;
    const text = humanText(m.content);
    if (!text) continue;
    const replyTo = typeof rel?.["m.in_reply_to"]?.event_id === "string" ? senderOf.get(rel["m.in_reply_to"].event_id) : undefined;
    const mentions = (m.content?.["m.mentions"] as { user_ids?: unknown } | undefined)?.user_ids;
    out.push({
      at: new Date(m.origin_server_ts).toISOString(),
      from: ownMxids.has(m.sender) ? "user" : "member",
      sender: m.sender,
      text,
      repliesToUser: !!replyTo && ownMxids.has(replyTo),
      mentionsUser: Array.isArray(mentions) && mentions.some((u) => typeof u === "string" && ownMxids.has(u)),
    });
  }
  return out;
}

interface GroupRow {
  roomId: string;
  name: string | null;
  memberCount: number;
  messageCount: number;
  channel: string;
  connectionId: string;
}

export interface GroupTagsSummary {
  status: "ok" | "failed" | "skipped";
  groups: number;
  posters: number;
  judged: number;
  reused: number;
  error: string | null;
}

export interface GroupTags {
  groups: Map<string, TaggedItem>;
  posters: Map<string, TaggedItem>;
  summary: GroupTagsSummary;
}

const stored = (v: { tags: ConnectionTag[] | null; tagScores: TagScores | null; userIds: string[] }): TaggedItem | null =>
  v.tags ? { tags: v.tags, scores: v.tagScores, userIds: v.userIds } : null;

/** Four yes/no questions on a state; returns the scores. */
async function judgeTags(state: unknown, key: string, brandName: string, tracking: ChatTrackingHeaders) {
  const questions: Record<string, NoulQuestion> = {};
  for (const tag of CONNECTION_TAGS) questions[`t_${tag}`] = { type: "noul", instructions: tagQuestionText(tag, brandName) };
  const result = await judgeQuestions(state, questions, tracking);
  return { scores: readTagScores(result.answers, key), model: result.model };
}

async function record(
  identity: SiblingIdentity,
  key: string,
  judgedThrough: string,
  contextHash: string,
  input: unknown,
  item: TaggedItem | null,
  model: string | null,
) {
  const values = {
    orgId: identity.orgId,
    brandId: identity.brandId,
    conversationKey: key,
    source: "matrix_group",
    content: item ? "readable" : "none",
    topic: null,
    confidence: null,
    probabilities: null,
    brandProbability: null,
    offerScores: null,
    offerIds: [],
    tagScores: item?.scores ?? null,
    tags: item?.tags ?? null,
    accountUserIds: item?.userIds ?? [],
    contextHash,
    judgedThrough,
    input,
    model,
    runId: identity.runId,
    judgedAt: new Date(),
  };
  const { orgId: _o, brandId: _b, conversationKey: _k, ...set } = values;
  await db
    .insert(conversationVerdicts)
    .values(values)
    .onConflictDoUpdate({ target: [conversationVerdicts.orgId, conversationVerdicts.brandId, conversationVerdicts.conversationKey], set });
}

/** A group with no word anyone wrote: its silent members are personal, not to the user. */
const NO_WORDS_GROUP: Omit<TaggedItem, "userIds"> = { tags: ["personal_not_to_user"], scores: null };

/**
 * Judge every group of the brand and every member's own posts that need it; reuse the rest.
 * `viewOf(contactId)` = what the brand's tools know of that member. A failure leaves that item on
 * its previous verdict (or none) and is reported; the rest go on.
 */
export async function resolveGroupTags(
  identity: SiblingIdentity,
  context: BrandContext,
  users: AccountUsers,
  viewOf: (contactId: string) => PersonView | null,
): Promise<GroupTags> {
  const groups: GroupRow[] = await db
    .select({
      roomId: matrixGroups.roomId,
      name: matrixGroups.name,
      memberCount: matrixGroups.memberCount,
      messageCount: matrixGroups.messageCount,
      channel: matrixGroups.channel,
      connectionId: matrixGroups.connectionId,
    })
    .from(matrixGroups)
    .where(and(eq(matrixGroups.orgId, identity.orgId), eq(matrixGroups.brandId, identity.brandId)));
  const out: GroupTags = {
    groups: new Map(),
    posters: new Map(),
    summary: { status: "ok", groups: groups.length, posters: 0, judged: 0, reused: 0, error: null },
  };
  if (groups.length === 0) return out;
  const posters = await db
    .select({
      roomId: matrixGroupMembers.roomId,
      contactId: matrixGroupMembers.contactId,
      ghost: matrixGroupMembers.ghostMxid,
      authored: matrixGroupMembers.authoredCount,
      lastAuthoredAt: matrixGroupMembers.lastAuthoredAt,
    })
    .from(matrixGroupMembers)
    .where(and(eq(matrixGroupMembers.orgId, identity.orgId), eq(matrixGroupMembers.brandId, identity.brandId), gt(matrixGroupMembers.authoredCount, 0)));
  out.summary.posters = posters.length;
  const own = new Set(
    (
      await db
        .select({ mxid: matrixConnections.matrixUserId })
        .from(matrixConnections)
        .where(and(eq(matrixConnections.orgId, identity.orgId), eq(matrixConnections.brandId, identity.brandId)))
    ).map((r) => r.mxid),
  );
  const contextHash = `${context.hash}|${users.hash.matrix}`;
  const groupKey = (g: GroupRow) => `group:${g.roomId}`;
  const posterKey = (p: { roomId: string; contactId: string }) => `group:${p.roomId}|${p.contactId}`;
  const groupThrough = (g: GroupRow) => `${g.name ?? ""}|${g.messageCount}`;
  const posterThrough = (p: { authored: number; lastAuthoredAt: Date | null }) => `${p.authored}|${p.lastAuthoredAt?.toISOString() ?? ""}`;
  const previous = await storedVerdicts(identity.orgId, identity.brandId, [...groups.map(groupKey), ...posters.map(posterKey)]);
  const fresh = (key: string, through: string) => {
    const s = previous.get(key);
    return !!s && s.judgedThrough === through && s.contextHash === contextHash;
  };
  const groupTodo = groups.filter((g) => !fresh(groupKey(g), groupThrough(g)));
  const posterTodo = posters.filter((p) => !fresh(posterKey(p), posterThrough(p)));

  // The rooms whose messages Jev must read this pass, in one read.
  const rooms = [...new Set([...groupTodo.map((g) => g.roomId), ...posterTodo.map((p) => p.roomId)])];
  const linesOf = new Map<string, GroupLine[]>();
  for (let i = 0; i < rooms.length; i += 200) {
    const rows = await db
      .select({ roomId: matrixRawEvents.roomId, payload: matrixRawEvents.payload })
      .from(matrixRawEvents)
      .where(
        and(
          eq(matrixRawEvents.orgId, identity.orgId),
          eq(matrixRawEvents.brandId, identity.brandId),
          eq(matrixRawEvents.eventType, "m.room.message"),
          inArray(matrixRawEvents.roomId, rooms.slice(i, i + 200)),
        ),
      );
    const byRoom = new Map<string, MatrixEvent[]>();
    for (const r of rows) byRoom.set(r.roomId, [...(byRoom.get(r.roomId) ?? []), r.payload as unknown as MatrixEvent]);
    for (const [room, events] of byRoom) linesOf.set(room, groupLines(events, own));
  }

  const tracking: ChatTrackingHeaders = { orgId: identity.orgId, userId: identity.userId, runId: identity.runId, brandIds: [identity.brandId] };
  const errors: string[] = [];
  const userOf = (g: GroupRow): { view: AccountUserView | null; ids: string[] } => {
    const acc = users.matrix.get(g.connectionId);
    return acc ? { view: accountUserView(acc.channel, acc.account, [acc.user]), ids: userIdsOf([acc.user]) } : { view: null, ids: [] };
  };
  const groupInfo = (g: GroupRow) => ({ name: g.name ? clip(g.name) : null, members: g.memberCount, channel: g.channel });
  const task =
    "A business owner (state.user) connected their own messaging account, which is in many GROUPS. Judge in what " +
    "capacity the counterpart speaks: personally (to the user, or not to the user) and/or in a work role (about what " +
    "the brand below sells, or about something else). Several can hold at once.";

  for (const g of groups) {
    const s = previous.get(groupKey(g));
    if (s && !groupTodo.includes(g)) {
      const item = stored(s) ?? { ...NO_WORDS_GROUP, userIds: s.userIds };
      out.groups.set(g.roomId, item);
      out.summary.reused++;
    }
  }
  await mapLimit(groupTodo, CONCURRENCY, async (g) => {
    const key = groupKey(g);
    try {
      const user = userOf(g);
      const lines = (linesOf.get(g.roomId) ?? []).slice(-GROUP_SAMPLE);
      const input = {
        key,
        kind: "group",
        group: groupInfo(g),
        user: user.view,
        messages: lines.map((l) => ({ at: l.at, from: l.from, text: clip(l.text) })),
      };
      if (lines.length === 0) {
        await record(identity, key, groupThrough(g), contextHash, input, null, null);
        out.groups.set(g.roomId, { ...NO_WORDS_GROUP, userIds: user.ids });
        return;
      }
      const state = {
        task: `${task} Here the counterpart is the GROUP as a whole: what is it, and what do its members talk about?`,
        brand: context.brand,
        offers: context.offers.map((o) => ({ name: o.name, description: o.description, whatItSells: o.profile ?? null })),
        otherBrandsOfTheSameOwner: context.otherBrandsOfTheSameOwner,
        user: user.view,
        group: input.group,
        latestMessages: input.messages,
      };
      const { scores, model } = await judgeTags(state, key, context.brand.name, tracking);
      const item: TaggedItem = { tags: tagsFromScores(scores), scores, userIds: user.ids };
      await record(identity, key, groupThrough(g), contextHash, input, item, model);
      out.groups.set(g.roomId, item);
      out.summary.judged++;
    } catch (err) {
      if (errors.length < 3) errors.push(`${key}: ${(err as Error).message}`);
      const s = previous.get(key);
      const item = s ? stored(s) : null;
      if (item) out.groups.set(g.roomId, item);
    }
  });

  const groupOf = new Map(groups.map((g) => [g.roomId, g]));
  for (const p of posters) {
    const s = previous.get(posterKey(p));
    if (s && !posterTodo.includes(p)) {
      const item = stored(s);
      if (item) out.posters.set(posterKey(p), item);
      out.summary.reused++;
    }
  }
  await mapLimit(posterTodo, CONCURRENCY, async (p) => {
    const key = posterKey(p);
    const g = groupOf.get(p.roomId);
    if (!g) return;
    try {
      const user = userOf(g);
      const own = threadWindow((linesOf.get(p.roomId) ?? []).filter((l) => l.sender === p.ghost));
      const input = {
        key,
        kind: "group_posts",
        group: groupInfo(g),
        user: user.view,
        person: viewOf(p.contactId),
        posts: own.map((l) => ({ at: l.at, text: clip(l.text), repliesToUser: l.repliesToUser, mentionsUser: l.mentionsUser })),
      };
      // No word of theirs to read (media only): they count as a silent member (the group's verdict).
      if (own.length === 0) {
        await record(identity, key, posterThrough(p), contextHash, input, null, null);
        return;
      }
      const group = out.groups.get(p.roomId);
      const state = {
        task:
          `${task} Here the counterpart is ONE MEMBER, judged on their own posts in the group. A post is "to the user" ` +
          "only when it replies to the user or mentions them (each post says so); otherwise a personal post is not to the user.",
        brand: context.brand,
        offers: context.offers.map((o) => ({ name: o.name, description: o.description, whatItSells: o.profile ?? null })),
        otherBrandsOfTheSameOwner: context.otherBrandsOfTheSameOwner,
        user: user.view,
        group: { ...input.group, judgedAs: group?.tags ?? null },
        counterpartKnownByTheBrand: input.person,
        counterpartPosts: input.posts,
      };
      const { scores, model } = await judgeTags(state, key, context.brand.name, tracking);
      const item: TaggedItem = { tags: tagsFromScores(scores), scores, userIds: user.ids };
      await record(identity, key, posterThrough(p), contextHash, input, item, model);
      out.posters.set(key, item);
      out.summary.judged++;
    } catch (err) {
      if (errors.length < 3) errors.push(`${key}: ${(err as Error).message}`);
      const s = previous.get(key);
      const item = s ? stored(s) : null;
      if (item) out.posters.set(key, item);
    }
  });
  if (errors.length) {
    out.summary.status = "failed";
    out.summary.error = errors.join(" | ").slice(0, 1000);
  }
  return out;
}
