import { describe, it, expect } from "vitest";
import { clusterPeople, type Presence } from "../../src/lib/people/identity.js";
import { normalizeHandle, preferredContactOf } from "../../src/lib/people/handles.js";

/** CONTACT-REDIRECT-1101: "reach me on this other number" joins the person and names where to reach them. */
const presence = (over: Partial<Presence>): Presence => ({
  source: "matrix",
  sourceRef: "x",
  displayName: null,
  company: null,
  emails: [],
  phones: [],
  firstActivityAt: null,
  lastActivityAt: null,
  messageCount: null,
  inboundCount: null,
  outboundCount: null,
  detail: {},
  ...over,
});

describe("stated handles", () => {
  it("normalises a phone or an email to its identity key; a national number is no handle", () => {
    expect(normalizeHandle({ phone: "+880 1952-666418" })).toEqual({ kind: "phone", handle: "+8801952666418", key: "phone:+8801952666418" });
    expect(normalizeHandle({ email: " Tahmid@X.com " })).toEqual({ kind: "email", handle: "tahmid@x.com", key: "email:tahmid@x.com" });
    expect(normalizeHandle({ phone: "01952666418" })).toBeNull();
  });

  it("ties the old thread (a LID-only WhatsApp chat) and the new number's thread into ONE person", () => {
    const oldRoom = presence({ sourceRef: "c-old", keys: ["matrix:c-old", "msg:whatsapp:lid-1"], detail: { channelHandle: "@whatsapp_lid-1:hs" } });
    const newRoom = presence({ sourceRef: "c-new", phones: ["+8801952666418"], keys: ["matrix:c-new"], detail: { channelHandle: "@whatsapp_lid-2:hs" } });
    const signup = presence({ source: "clerk", sourceRef: "u1", emails: ["tahmid@x.com"] });
    expect(clusterPeople([oldRoom, newRoom, signup], [])).toHaveLength(3);
    const stated = {
      kind: "stated_handle" as const,
      ref: "h1",
      displayName: null,
      company: null,
      emails: ["tahmid@x.com"],
      phones: ["+8801952666418"],
      keys: ["email:tahmid@x.com", "matrix:c-old", "msg:whatsapp:lid-1", "phone:+8801952666418"],
    };
    const people = clusterPeople([oldRoom, newRoom, signup], [stated]);
    expect(people).toHaveLength(1);
    expect(people[0].personKey).toBe("email:tahmid@x.com");
    expect(people[0].phones).toEqual(["+8801952666418"]);
    expect(people[0].evidence.map((e) => e.kind)).toEqual(["stated_handle"]);
  });

  it("reads the latest preferred handle per kind off the person's merge evidence", () => {
    const st = (handleId: string, kind: "phone" | "email", handle: string, preferred: boolean, statedAt: string) => ({
      kind: "stated_handle",
      ref: handleId,
      statement: { handleId, kind, handle, preferred, channel: kind === "phone" ? "whatsapp" : null, statedAt },
    });
    expect(preferredContactOf([])).toBeNull();
    expect(preferredContactOf([{ kind: "stated_merge", ref: "m" }, st("a", "phone", "+1", false, "2026-11-01T00:00:00Z")])).toBeNull();
    const pc = preferredContactOf([
      st("a", "phone", "+1", true, "2026-11-01T00:00:00Z"),
      st("b", "phone", "+2", true, "2026-11-02T00:00:00Z"),
      st("c", "phone", "+3", false, "2026-11-03T00:00:00Z"),
    ]);
    expect(pc).toEqual({ phone: expect.objectContaining({ handleId: "b", handle: "+2" }), email: null });
  });
});
