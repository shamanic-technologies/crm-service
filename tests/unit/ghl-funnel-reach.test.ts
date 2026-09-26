import { describe, expect, it } from "vitest";
import { tallyReach } from "../../src/lib/gohighlevel/funnel-reach.js";

type Row = Parameters<typeof tallyReach>[0][number];

function byStep(rows: Row[]) {
  return Object.fromEntries(tallyReach(rows).map((s) => [s.step, s]));
}

describe("tallyReach", () => {
  it("counts contacts, not events", () => {
    const steps = byStep([
      { contact_id: "a", step: "meeting_booked", source: "appointment" },
      { contact_id: "a", step: "meeting_booked", source: "stage_entry" },
      { contact_id: "b", step: "meeting_booked", source: "appointment" },
    ]);
    expect(steps.meeting_booked.contacts).toBe(2);
    expect(steps.meeting_booked.bySource).toEqual({ appointment: 2, stage_entry: 1 });
  });

  it("serves every step, zeros included", () => {
    const steps = tallyReach([]);
    expect(steps.map((s) => s.step)).toEqual([
      "form_submitted",
      "meeting_booked",
      "meeting_attended",
      "meeting_not_held",
      "sale",
      "deal_lost",
    ]);
    expect(steps.every((s) => s.contacts === 0 && s.contactsAtOrBeyond === 0)).toBe(true);
  });

  it("a sale proves the booking and the meeting; a no-show proves the booking only", () => {
    const steps = byStep([
      // Parked in a sale stage at first observation: no booking on record.
      { contact_id: "won", step: "sale", source: "stage_entry" },
      { contact_id: "showed", step: "meeting_attended", source: "stage_entry" },
      { contact_id: "noshow", step: "meeting_not_held", source: "appointment" },
      { contact_id: "booked", step: "meeting_booked", source: "appointment" },
      { contact_id: "lost", step: "deal_lost", source: "lost_status" },
      { contact_id: "form", step: "form_submitted", source: "form_submission" },
    ]);
    expect(steps.meeting_booked).toMatchObject({ contacts: 1, contactsAtOrBeyond: 4 });
    expect(steps.meeting_attended).toMatchObject({ contacts: 1, contactsAtOrBeyond: 2 });
    expect(steps.sale).toMatchObject({ contacts: 1, contactsAtOrBeyond: 1 });
    // Implied by nothing.
    expect(steps.meeting_not_held.contactsAtOrBeyond).toBe(1);
    expect(steps.deal_lost.contactsAtOrBeyond).toBe(1);
    expect(steps.form_submitted.contactsAtOrBeyond).toBe(1);
  });

  it("is monotone along booked → attended → sale", () => {
    const steps = byStep([
      { contact_id: "x", step: "sale", source: "won_status" },
      { contact_id: "y", step: "sale", source: "stage_entry" },
      { contact_id: "y", step: "meeting_attended", source: "appointment" },
    ]);
    expect(steps.meeting_booked.contactsAtOrBeyond).toBeGreaterThanOrEqual(
      steps.meeting_attended.contactsAtOrBeyond,
    );
    expect(steps.meeting_attended.contactsAtOrBeyond).toBeGreaterThanOrEqual(
      steps.sale.contactsAtOrBeyond,
    );
  });

  it("fails loud on a step it does not know", () => {
    expect(() => tallyReach([{ contact_id: "a", step: "mystery", source: "appointment" }])).toThrow(
      /unknown step/,
    );
  });
});
