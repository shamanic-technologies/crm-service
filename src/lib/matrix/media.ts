/**
 * A PHOTO A PERSON SENT, AS THE ANSWERING AI READS IT (SOPHIE-WA-HUMAN-1106, owner 2026-11-04 « quid de mettre des
 * images en input de son prompt ? »): the image goes to the model AS IS, never described to text here.
 *
 * Every message reader names a photo by its event id (`photo` on a burst message, a thread line, a timeline item);
 * `GET /orgs/matrix/media?brandId=&eventId=` answers its bytes, base64, for the org + brand whose line received it,
 * downloaded from our homeserver with the receiving account's token (as voice notes are). Nothing stored, no cost.
 */
import { and, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { matrixConnections, matrixRawEvents } from "../../db/schema.js";
import type { MatrixEvent } from "./client.js";
import { isOwnSender, photoOf, type PhotoRef } from "./events.js";
import { downloadMedia } from "./voice-notes.js";
import { connectionOwnSenders } from "./own-senders.js";

/** Larger photos are refused (a vision model takes ~5 MB per image; WhatsApp photos are ~0.1-0.5 MB). */
export const PHOTO_MAX_BYTES = 10 * 1024 * 1024;

export type MediaRefusalCode = "message_not_found" | "not_an_image" | "too_large";

export class MediaRefusal extends Error {
  constructor(
    readonly code: MediaRefusalCode,
    message: string,
    readonly httpStatus: number,
  ) {
    super(message);
  }
}

export interface MessagePhoto {
  eventId: string;
  roomId: string;
  sentAt: string;
  /** inbound = the person sent it, outbound = the brand's account did. */
  direction: "inbound" | "outbound";
  /** As the sender's client stated it, else `image/jpeg` (what WhatsApp sends). */
  mimeType: string;
  sizeBytes: number;
  caption: string | null;
  base64: string;
}

/**
 * The photo of message `eventId`, received on a line of this org + brand. Throws `MediaRefusal` (404 not ours or
 * unknown, 422 not a photo, 413 too large); a homeserver failure propagates (the route answers 502).
 */
export async function readMessagePhoto(
  orgId: string,
  brandId: string,
  eventId: string,
  download: (conn: { accessToken: string | null }, mxc: string) => Promise<Buffer> = downloadMedia,
): Promise<MessagePhoto> {
  const [row] = await db
    .select({
      payload: matrixRawEvents.payload,
      roomId: matrixRawEvents.roomId,
      connectionId: matrixConnections.id,
      accessToken: matrixConnections.accessToken,
      ownMxid: matrixConnections.matrixUserId,
      counterpartPrefix: matrixConnections.counterpartPrefix,
    })
    .from(matrixRawEvents)
    .innerJoin(matrixConnections, eq(matrixConnections.id, matrixRawEvents.connectionId))
    .where(and(eq(matrixRawEvents.eventId, eventId), eq(matrixConnections.orgId, orgId), eq(matrixConnections.brandId, brandId)))
    .limit(1);
  if (!row) throw new MediaRefusal("message_not_found", `No message ${eventId} on this brand's lines.`, 404);
  const e = row.payload as unknown as MatrixEvent;
  const photo: PhotoRef | null = photoOf(e.content, eventId);
  if (!photo) throw new MediaRefusal("not_an_image", `Message ${eventId} is not a photo.`, 422);
  if (photo.sizeBytes !== null && photo.sizeBytes > PHOTO_MAX_BYTES) {
    throw new MediaRefusal("too_large", `The photo is ${photo.sizeBytes} bytes, the limit is ${PHOTO_MAX_BYTES}.`, 413);
  }
  const file = await download({ accessToken: row.accessToken }, e.content!.url as string);
  if (file.length > PHOTO_MAX_BYTES) throw new MediaRefusal("too_large", `The photo is ${file.length} bytes, the limit is ${PHOTO_MAX_BYTES}.`, 413);
  return {
    eventId,
    roomId: row.roomId,
    sentAt: new Date(e.origin_server_ts).toISOString(),
    direction: isOwnSender(e.sender, await connectionOwnSenders({ id: row.connectionId, matrixUserId: row.ownMxid, counterpartPrefix: row.counterpartPrefix })) ? "outbound" : "inbound",
    mimeType: photo.mimeType ?? "image/jpeg",
    sizeBytes: file.length,
    caption: photo.caption,
    base64: file.toString("base64"),
  };
}
