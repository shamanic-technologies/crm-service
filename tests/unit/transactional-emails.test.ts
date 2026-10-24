import { describe, expect, it } from "vitest";
import { htmlToText, parseFeedEmail, readableBody } from "../../src/lib/transactional/sent-emails.js";

const row = {
  id: "7ec7ec7e-1111-4111-8111-0000000000f1",
  eventType: "campaign_created",
  recipientEmail: "a@b.co",
  orgId: null,
  brandIds: ["7ec7ec7e-1111-4111-8111-0000000000f2"],
  from: null,
  subject: null,
  textBody: null,
  htmlBody: null,
  sentAt: "2026-03-01T00:00:00.000Z",
  messageSource: "unavailable",
};

describe("transactional email feed rows", () => {
  it("keeps an unavailable past send (no subject, no body) as a dated email", () => {
    expect(parseFeedEmail(row)).toMatchObject({ id: row.id, subject: null, textBody: null, messageSource: "unavailable" });
    expect(readableBody(parseFeedEmail(row))).toBeNull();
  });
  it("refuses a row the thread cannot place", () => {
    expect(() => parseFeedEmail({ ...row, id: "x" })).toThrow(/uuid id/);
    expect(() => parseFeedEmail({ ...row, recipientEmail: null })).toThrow(/recipientEmail/);
    expect(() => parseFeedEmail({ ...row, messageSource: "maybe" })).toThrow(/messageSource/);
  });
  it("reads the text part first, else the words of the HTML", () => {
    expect(readableBody({ textBody: " Hi ", htmlBody: "<p>ignored</p>" })).toBe("Hi");
    expect(readableBody({ textBody: null, htmlBody: "<style>.a{}</style><p>Hello&nbsp;Jane,</p><br>Your <b>budget</b> is $5 &#8364; &lt;3" })).toBe(
      "Hello Jane,\n\nYour budget is $5 € <3",
    );
    expect(htmlToText("<div>a</div><div>b</div>")).toBe("a\nb");
  });
});
