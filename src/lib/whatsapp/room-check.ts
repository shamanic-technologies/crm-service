/**
 * Does this DM room deliver to the person we resolved? (JACKSON-WA-WRONG-ROOM,
 * 2026-10-12.) mautrix-whatsapp once gave two portals the SAME Matrix room
 * during a mass resync (room v12 ids are a hash of the create event): the
 * owner's own number's DM became, for the bridge, the DM of a friend. Its
 * `resolve_identifier` still answered that room for the owner's number, so 8
 * test messages "to" the owner reached the friend.
 *
 * The bridge states whom a room talks to in the room's `m.bridge` state
 * (`channel.id` = the counterpart's JID, `fi.mau.receiver` = the login). A send
 * posts only into a room where EVERY such statement names the resolved person
 * (their LID JID, or the phone's own JID) on the sending login. Pure.
 */

import type { RoomBridgeInfo } from "../matrix/client.js";

const digitsOf = (s: string) => s.replace(/\D/g, "");

/**
 * The JIDs a DM with this person may carry as its channel: the LID the bridge
 * resolved (`lid-123` → `123@lid`), a phone id (`336…` → `336…@s.whatsapp.net`),
 * and the requested phone's own JID.
 */
export function expectedChannelIds(resolvedId: string, phone: string): Set<string> {
  const ids = new Set<string>([`${digitsOf(phone)}@s.whatsapp.net`]);
  if (resolvedId.includes("@")) ids.add(resolvedId);
  else if (resolvedId.startsWith("lid-")) ids.add(`${resolvedId.slice(4)}@lid`);
  else if (/^\d+$/.test(resolvedId)) ids.add(`${resolvedId}@s.whatsapp.net`);
  return ids;
}

export type RoomVerdict = { ok: true } | { ok: false; actual: string };

/** `ok` only when the room carries bridge state and all of it names this person on this login. */
export function roomDeliversTo(info: RoomBridgeInfo[], expected: Set<string>, loginId: string): RoomVerdict {
  const describe = () =>
    info.length === 0
      ? "no bridge state"
      : info.map((i) => `${i.channelId ?? "?"} (${i.displayname ?? "no name"}, receiver ${i.receiver ?? "?"})`).join("; ");
  if (info.length === 0) return { ok: false, actual: describe() };
  const login = digitsOf(loginId);
  const allMatch = info.every(
    (i) => i.channelId !== null && expected.has(i.channelId) && (i.receiver === null || digitsOf(i.receiver) === login),
  );
  return allMatch ? { ok: true } : { ok: false, actual: describe() };
}
