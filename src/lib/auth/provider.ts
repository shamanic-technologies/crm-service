/**
 * An AUTH PROVIDER is the tool holding every person who signed up to a brand's
 * product (Clerk today; Supabase Auth, Auth0, Firebase Auth are siblings to
 * come). Each one is a read-only adapter behind this one interface, so the
 * connection routes, the sync, the people layer and the fact feed are written
 * once and a new provider is one new file registered in `AUTH_PROVIDERS`.
 *
 * Every adapter is READ ONLY: it lists users and counts them, nothing else.
 */

/** A non-2xx answer from the provider, carrying its own status and words. */
export class AuthProviderError extends Error {
  readonly status: number;
  readonly vendorMessage: string;
  constructor(label: string, status: number, vendorMessage: string) {
    super(`${label} returned ${status}: ${vendorMessage}`);
    this.name = "AuthProviderError";
    this.status = status;
    this.vendorMessage = vendorMessage;
  }
}

/** One user, derived from the provider's record — pure, deterministic, no model. */
export interface DerivedAuthUser {
  externalId: string;
  /** Addresses the provider holds as the user's own (verified), primary first. */
  emails: string[];
  /** Phone numbers the provider holds as the user's own (verified, or typed on their profile), primary first, verbatim. */
  phones: string[];
  /** Where each phone was read (`clerk_phone_number`, `clerk_public_metadata.phone`…). */
  phoneSources: { phone: string; via: string }[];
  firstName: string | null;
  lastName: string | null;
  fullName: string | null;
  /** When the user signed up — the provider's own creation date. */
  createdAt: Date | null;
  updatedAt: Date | null;
  /** The provider's last sign-in / activity date, when it reports one. */
  lastActiveAt: Date | null;
}

/**
 * One membership of a user in one of the product's ORGANIZATIONS (teams), with
 * the user who created that organization. It is what tells a SIGNUP (someone
 * who came to the product on their own) from a TEAMMATE invited into an
 * organization somebody else created.
 */
export interface DerivedAuthMembership {
  externalId: string;
  userId: string;
  orgId: string;
  /** The user who created the organization; null when the provider names nobody. */
  orgCreatedBy: string | null;
}

/**
 * Signed up = came to the product on their own. A user is NOT a signup only on
 * positive evidence: they belong to at least one organization and EVERY one of
 * them was created by someone else (they were invited in). A user in no
 * organization, or in one the provider names no creator for, is a signup.
 */
export function isSignup(userId: string, memberships: Pick<DerivedAuthMembership, "orgCreatedBy">[]): boolean {
  if (memberships.length === 0) return true;
  return !memberships.every((m) => m.orgCreatedBy !== null && m.orgCreatedBy !== userId);
}

export interface AuthProviderAdapter {
  /** Provider name: the key-service provider, the `contacts.source`, the people source. */
  name: string;
  label: string;
  /** Proves the key reads the users (the scope the sync needs) and returns the provider's own user count. */
  countUsers(secretKey: string): Promise<number>;
  /** Every user, page by page, verbatim minus the provider's server-only secrets. */
  listUsers(secretKey: string): AsyncGenerator<Record<string, unknown>[]>;
  /** The record's id in the provider. */
  idOf(record: Record<string, unknown>): string;
  derive(record: Record<string, unknown>): DerivedAuthUser | null;
  /**
   * Organization memberships, for a provider with organizations (Clerk). The
   * provider's own total, then every membership page by page, verbatim minus
   * server-only secrets. Absent = the provider has no organizations: every user
   * is a signup.
   */
  memberships?: {
    count(secretKey: string): Promise<number>;
    list(secretKey: string): AsyncGenerator<Record<string, unknown>[]>;
    derive(record: Record<string, unknown>): DerivedAuthMembership | null;
  };
  /** Shape check on the pasted key, before any call (null = acceptable). */
  rejectKey(secretKey: string): string | null;
}
