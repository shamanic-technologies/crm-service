/**
 * WHO "the user" is, per connected account (CONNECTION-TAGS-1017).
 *
 * "Personal" is judged against the user who connected the account: Jev must know who
 * that is (name, addresses, numbers) to tell "a friend writing to Kevin" from "a member
 * chatting in a group Kevin is in". Recorded facts only:
 *   - a Matrix account (WhatsApp, LinkedIn, Telegram) = the member who linked it
 *     (`matrix_connections.created_by_user_id`), plus the account's own name on the network;
 *   - a Gmail mailbox (Gmail is per ORG, google-service `GET /orgs/google/accounts`) = the
 *     org member holding that address, else the mailbox alone (owner not a member).
 * Members come from client-service (`/internal/users?orgId=&allMembers=true`).
 * Unreadable = throws: nothing is judged this pass rather than judged against nobody.
 */
import { createHash } from "node:crypto";
import { eq, and } from "drizzle-orm";
import { db } from "../../db/index.js";
import { matrixConnections, matrixLinks } from "../../db/schema.js";
import { normalizeEmail, normalizePhone } from "./identity.js";
import { siblingGet, siblingGetOk, type SiblingIdentity } from "./siblings.js";

export interface AccountUser {
  /** client-service's internal user id; null = the account's owner is no member of the org. */
  userId: string | null;
  name: string | null;
  emails: string[];
  phones: string[];
}

/** What Jev is shown about the user of one account. */
export interface AccountUserView {
  channel: string;
  /** The account itself: the mailbox address, or the account's name on the network. */
  account: string | null;
  users: { name: string | null; emails: string[]; phones: string[] }[];
}

export interface AccountUsers {
  /** Owners of the org's mailboxes (one entry per mailbox). */
  gmail: { mailbox: string; user: AccountUser }[];
  /** Matrix connection id → its user + the account's name. */
  matrix: Map<string, { channel: string; account: string | null; user: AccountUser }>;
  /** Stable digest of who the users are, per source: a change re-judges that source's threads once. */
  hash: { gmail: string; matrix: string };
}

interface ClientUser {
  id: string;
  email: string | null;
  phone: string | null;
  firstName: string | null;
  lastName: string | null;
}

const nameOf = (u: ClientUser) => [u.firstName, u.lastName].filter((s) => s && s.trim()).join(" ").trim() || null;

/** PURE: a client-service user as an AccountUser. */
export function accountUserOf(u: ClientUser): AccountUser {
  const e = normalizeEmail(u.email);
  const p = normalizePhone(u.phone);
  return { userId: u.id, name: nameOf(u), emails: e ? [e] : [], phones: p ? [p] : [] };
}

/** `gmailReadable` false (the build could not read the mailbox): no mailbox is asked, no Gmail thread is judged. */
export async function readAccountUsers(identity: SiblingIdentity, gmailReadable: boolean): Promise<AccountUsers> {
  const path = `/internal/users?orgId=${encodeURIComponent(identity.orgId)}&allMembers=true`;
  const body = await siblingGetOk<{ users: ClientUser[] }>("client", path, identity);
  if (!Array.isArray(body?.users)) throw new Error(`client-service GET ${path} answered no users list`);
  const members = body.users;
  const byId = new Map(members.map((u) => [u.id, u]));
  const byEmail = new Map<string, ClientUser>();
  for (const u of members) {
    const e = normalizeEmail(u.email);
    if (e) byEmail.set(e, u);
  }

  const gmail: AccountUsers["gmail"] = [];
  const accounts: { email: string }[] = [];
  if (gmailReadable) {
    const r = await siblingGet("google", "/orgs/google/accounts", identity);
    if (r.status !== 200) throw new Error(`google-service GET /orgs/google/accounts returned ${r.status}`);
    accounts.push(...((r.body as { accounts: { email: string }[] }).accounts ?? []));
  }
  for (const a of accounts) {
    const mailbox = normalizeEmail(a.email);
    if (!mailbox) continue;
    const member = byEmail.get(mailbox);
    const user = member ? accountUserOf(member) : { userId: null, name: null, emails: [], phones: [] };
    if (!user.emails.includes(mailbox)) user.emails.push(mailbox);
    gmail.push({ mailbox, user });
  }

  const rows = await db
    .select({
      id: matrixConnections.id,
      channel: matrixConnections.channel,
      createdBy: matrixConnections.createdByUserId,
      remoteName: matrixLinks.remoteName,
    })
    .from(matrixConnections)
    .leftJoin(
      matrixLinks,
      and(eq(matrixLinks.matrixUserId, matrixConnections.matrixUserId), eq(matrixLinks.brandId, matrixConnections.brandId)),
    )
    .where(and(eq(matrixConnections.orgId, identity.orgId), eq(matrixConnections.brandId, identity.brandId)));
  const matrix: AccountUsers["matrix"] = new Map();
  for (const c of rows) {
    const member = byId.get(c.createdBy);
    const user = member ? accountUserOf(member) : { userId: c.createdBy, name: null, emails: [], phones: [] };
    matrix.set(c.id, { channel: c.channel, account: c.remoteName ?? null, user });
  }

  const digest = (x: unknown) => createHash("sha256").update(JSON.stringify(x)).digest("hex").slice(0, 16);
  return {
    gmail,
    matrix,
    hash: {
      gmail: digest(gmail.map((g) => [g.mailbox, g.user.userId, g.user.name, g.user.phones]).sort()),
      matrix: digest([...matrix.entries()].map(([id, m]) => [id, m.account, m.user.userId, m.user.name, m.user.emails, m.user.phones]).sort()),
    },
  };
}

/** PURE: what Jev reads about the user of an account. */
export function accountUserView(channel: string, account: string | null, users: AccountUser[]): AccountUserView {
  return { channel, account, users: users.map((u) => ({ name: u.name, emails: u.emails, phones: u.phones })) };
}

/** PURE: the user ids a personal tag names (a mailbox owner outside the org is named by nobody). */
export function userIdsOf(users: AccountUser[]): string[] {
  return [...new Set(users.map((u) => u.userId).filter((u): u is string => !!u))].sort();
}
