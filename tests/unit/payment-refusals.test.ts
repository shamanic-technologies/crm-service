import { describe, expect, it } from "vitest";
import {
  PAYMENT_REFUSED_KIND,
  isRefusedCharge,
  latestPerPerson,
  refusalIdempotencyKey,
  refusalIsFresh,
  refusalOccurrenceBody,
  refusalVerdict,
} from "../../src/lib/payment-refusals/rules.js";

const NOW = Date.parse("2026-11-03T16:00:00Z");
const H = 60 * 60 * 1000;

describe("refused charge = Lead event (REFUSED-CARD-LEAD-EVENT-1103)", () => {
  it("only a failed payment is a refusal", () => {
    expect(isRefusedCharge({ kind: "payment", status: "failed" })).toBe(true);
    expect(isRefusedCharge({ kind: "payment", status: "succeeded" })).toBe(false);
    expect(isRefusedCharge({ kind: "payment", status: "pending" })).toBe(false);
    expect(isRefusedCharge({ kind: "refund", status: "failed" })).toBe(false);
  });

  it("never history: before the connection, or older than 24 h", () => {
    const conn = new Date(NOW - 30 * 24 * H);
    expect(refusalIsFresh(new Date(NOW - H), conn, NOW)).toBe(true);
    expect(refusalIsFresh(new Date(NOW - 25 * H), conn, NOW)).toBe(false);
    expect(refusalIsFresh(new Date(NOW - H), new Date(NOW - 10 * 60_000), NOW)).toBe(false);
  });

  it("staff and nobody named are skipped; a phone alone is a person", () => {
    expect(refusalVerdict("Kevin@Distribute.you", null)).toMatchObject({ status: "skipped", reason: "staff" });
    expect(refusalVerdict("kevin@pressbeat.io", null)).toMatchObject({ status: "skipped", reason: "staff" });
    expect(refusalVerdict(null, null)).toMatchObject({ status: "skipped", reason: "no_email_or_phone" });
    expect(refusalVerdict(" Chaim@BeyondLogic.tech ", null)).toEqual({ status: "pending", email: "chaim@beyondlogic.tech", phone: null });
    expect(refusalVerdict(null, "+33612345678")).toEqual({ status: "pending", email: null, phone: "+33612345678" });
  });

  it("several refusals of one person waiting together: the latest is reported, the others superseded", () => {
    const r = (id: string, email: string, h: number, brandId = "b1") => ({ id, brandId, email, phone: null, chargedAt: new Date(NOW - h * H), chargeId: `ch_${id}` });
    const { report, superseded } = latestPerPerson([r("1", "a@x.com", 3), r("2", "a@x.com", 1), r("3", "b@x.com", 2), r("4", "a@x.com", 1, "b2")]);
    expect(report.map((x) => x.id).sort()).toEqual(["2", "3", "4"]);
    expect(superseded.map((x) => x.id)).toEqual(["1"]);
  });

  it("the door body: account_event, payment_refused, one key per charge x person x offer", () => {
    const body = refusalOccurrenceBody({
      brandId: "b1",
      offerId: "o1",
      email: "chaim@beyondlogic.tech",
      phone: null,
      name: "Chaim Tesser",
      chargeId: "ch_1",
      chargedAt: new Date(NOW),
      amountMinor: 5002,
      currency: "usd",
      description: "Top-up",
      detail: { failureMessage: "Your card has insufficient funds." },
      stripeAccountId: "acct_1",
    });
    expect(body).toMatchObject({
      triggerId: "account_event",
      brandId: "b1",
      offerId: "o1",
      idempotencyKey: refusalIdempotencyKey("ch_1", "chaim@beyondlogic.tech", "o1"),
      person: { email: "chaim@beyondlogic.tech", name: "Chaim Tesser" },
      item: { kind: PAYMENT_REFUSED_KIND, chargeId: "ch_1", amount: "$50.02", reason: "Your card has insufficient funds." },
    });
    expect((body.item as { text: string }).text).toBe("Payment refused: $50.02 · Your card has insufficient funds. · Top-up");
    expect("phone" in (body.person as object)).toBe(false);
    expect(refusalIdempotencyKey("ch_1", "a@x.com", "o1")).not.toBe(refusalIdempotencyKey("ch_2", "a@x.com", "o1"));
  });
});
