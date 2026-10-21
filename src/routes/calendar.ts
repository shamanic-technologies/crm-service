/**
 * Meetings from the brand's connected Google Calendar (lib/calendar/, GOOGLE-CALENDAR-MEETING-FACTS-1021):
 *  - GET  /orgs/calendar/meetings?brandId=  every meeting attendee of the brand and who they are judged to be;
 *  - POST /internal/calendar/watch          run one pass now (the in-process loop runs every 5 min).
 */
import { Router } from "express";
import { z } from "zod";
import { apiKeyAuth, requireOrg, AuthenticatedRequest } from "../middleware/auth.js";
import { runCalendarWatchNow } from "../lib/calendar/feed.js";
import { meetingFactContext, readOrgEvents, readScopePeople } from "../lib/calendar/matching.js";
import { externalAttendees, latestPerGoogleEvent, meetingCandidateFacts } from "../lib/calendar/meetings.js";
import { db } from "../db/index.js";
import { peopleScopes } from "../db/schema.js";
import { and, eq } from "drizzle-orm";

const router = Router();
const brandIdSchema = z.string().uuid();

router.get("/orgs/calendar/meetings", apiKeyAuth, requireOrg("calendar.meetings"), async (req: AuthenticatedRequest, res) => {
  const brand = brandIdSchema.safeParse(req.query.brandId);
  if (!brand.success) return res.status(400).json({ type: "validation", error: "brandId (uuid) query is required" });
  const [scope] = await db
    .select()
    .from(peopleScopes)
    .where(and(eq(peopleScopes.orgId, req.orgId!), eq(peopleScopes.brandId, brand.data)));
  const events = latestPerGoogleEvent(await readOrgEvents(req.orgId!));
  const pool = scope ? await readScopePeople(scope) : [];
  const ctx = await meetingFactContext(req.orgId!, brand.data, pool);
  const facts = meetingCandidateFacts(events, ctx);
  res.json({
    meetings: events.map((e) => ({
      googleEventId: e.googleEventId,
      calendarEmail: e.calendarEmail,
      status: e.status,
      title: e.title,
      startAt: e.startAt,
      bookedAt: e.bookedAt,
      meetStatus: e.meet.status,
      attendees: externalAttendees(e, new Set()).map((a) => {
        const who = ctx.identityOf(a.email);
        return {
          email: a.email,
          displayName: a.displayName,
          registered: ctx.registered.has(a.email),
          person: who ? { personId: who.person.personId, displayName: who.person.displayName, basis: who.basis, confidence: who.confidence } : null,
        };
      }),
      facts: facts
        .filter((f) => f.sourceRef === e.googleEventId)
        .map((f) => ({ type: f.type, attendeeEmail: f.sourceContactId, occurredAt: f.occurredAt, dateBasis: f.dateBasis })),
    })),
  });
});

/** Run one calendar pass now and answer what it did. */
router.post("/internal/calendar/watch", apiKeyAuth, async (_req, res) => {
  try {
    res.json(await runCalendarWatchNow());
  } catch (err) {
    console.error("[crm-service][calendar] manual pass failed:", err);
    res.status(502).json({ type: "upstream", error: (err as Error).message });
  }
});

export default router;
