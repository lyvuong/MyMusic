import type { FamilyInfo } from "../shared/types";
import type { User } from "./auth";

export interface Membership {
  familyId: string;
  role: "owner" | "member";
}

const INVITE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no look-alike characters
const INVITE_TTL_MS = 7 * 24 * 3600 * 1000;

export async function membershipOf(db: D1Database, uid: string): Promise<Membership | null> {
  const r = await db.prepare("SELECT family_id, role FROM members WHERE uid = ?").bind(uid)
    .first<{ family_id: string; role: "owner" | "member" }>();
  return r ? { familyId: r.family_id, role: r.role } : null;
}

export async function familyInfo(db: D1Database, m: Membership): Promise<FamilyInfo> {
  const fam = await db.prepare("SELECT name FROM families WHERE id = ?").bind(m.familyId).first<{ name: string }>();
  const mem = await db.prepare("SELECT uid, display_name, email, role FROM members WHERE family_id = ? ORDER BY joined_at")
    .bind(m.familyId).all<{ uid: string; display_name: string; email: string; role: "owner" | "member" }>();
  return {
    id: m.familyId,
    name: fam?.name ?? "",
    role: m.role,
    members: mem.results.map((r) => ({ uid: r.uid, displayName: r.display_name, email: r.email, role: r.role })),
  };
}

/** Creates a family owned by `user`. Returns null if the user already belongs to one. */
export async function createFamily(db: D1Database, user: User, name: string): Promise<Membership | null> {
  if (await membershipOf(db, user.uid)) return null;
  const id = crypto.randomUUID();
  const now = Date.now();
  await db.batch([
    db.prepare("INSERT INTO families (id, name, owner_uid, created_at) VALUES (?, ?, ?, ?)").bind(id, name, user.uid, now),
    db.prepare("INSERT INTO members (uid, family_id, email, display_name, role, joined_at) VALUES (?, ?, ?, ?, 'owner', ?)")
      .bind(user.uid, id, user.email, user.name, now),
  ]);
  return { familyId: id, role: "owner" };
}

export async function createInvite(db: D1Database, familyId: string, createdBy: string, maxUses = 10) {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const code = Array.from(bytes, (b) => INVITE_ALPHABET[b % INVITE_ALPHABET.length]).join("");
  const expiresAt = Date.now() + INVITE_TTL_MS;
  await db.prepare("INSERT INTO invites (code, family_id, created_by, expires_at, max_uses) VALUES (?, ?, ?, ?, ?)")
    .bind(code, familyId, createdBy, expiresAt, maxUses).run();
  return { code, expiresAt };
}

/** Joins the family behind an invite code. Returns null if the code is invalid/expired/used up or the user is already in a family. */
export async function joinWithInvite(db: D1Database, user: User, rawCode: string): Promise<Membership | null> {
  if (await membershipOf(db, user.uid)) return null;
  const code = rawCode.trim().toUpperCase();
  const now = Date.now();
  // The conditional UPDATE claims one use atomically, so two joins can't exceed max_uses.
  const claimed = await db.prepare("UPDATE invites SET uses = uses + 1 WHERE code = ? AND expires_at > ? AND uses < max_uses RETURNING family_id")
    .bind(code, now).first<{ family_id: string }>();
  if (!claimed) return null;
  await db.prepare("INSERT INTO members (uid, family_id, email, display_name, role, joined_at) VALUES (?, ?, ?, ?, 'member', ?)")
    .bind(user.uid, claimed.family_id, user.email, user.name, now).run();
  return { familyId: claimed.family_id, role: "member" };
}

/**
 * Removes a member (self-leave, owner removal, or account deletion). Their playlists go with them.
 * If the owner leaves, the longest-standing member becomes owner; if nobody is left the whole
 * family (tracks, playlists, R2 files) is deleted.
 */
export async function removeMember(env: Env, uid: string): Promise<void> {
  const m = await membershipOf(env.DB, uid);
  if (!m) return;
  const db = env.DB;
  await db.batch([
    db.prepare("DELETE FROM playlist_tracks WHERE playlist_id IN (SELECT id FROM playlists WHERE owner_uid = ?)").bind(uid),
    db.prepare("DELETE FROM playlists WHERE owner_uid = ?").bind(uid),
    db.prepare("DELETE FROM ratings WHERE uid = ?").bind(uid),
    db.prepare("DELETE FROM plays WHERE uid = ?").bind(uid),
    db.prepare("DELETE FROM daily_mixes WHERE uid = ?").bind(uid),
    db.prepare("DELETE FROM members WHERE uid = ?").bind(uid),
  ]);
  const next = await db.prepare("SELECT uid FROM members WHERE family_id = ? ORDER BY joined_at LIMIT 1")
    .bind(m.familyId).first<{ uid: string }>();
  if (next) {
    if (m.role === "owner") {
      await db.batch([
        db.prepare("UPDATE members SET role = 'owner' WHERE uid = ?").bind(next.uid),
        db.prepare("UPDATE families SET owner_uid = ? WHERE id = ?").bind(next.uid, m.familyId),
      ]);
    }
    return;
  }
  await deleteFamily(env, m.familyId);
}

async function deleteFamily(env: Env, familyId: string) {
  const keys = await env.DB.prepare("SELECT source_key, art_key FROM tracks WHERE family_id = ? AND source = 'r2'")
    .bind(familyId).all<{ source_key: string; art_key: string | null }>();
  const all = keys.results.flatMap((k) => (k.art_key ? [k.source_key, k.art_key] : [k.source_key]));
  for (let i = 0; i < all.length; i += 1000) await env.MUSIC.delete(all.slice(i, i + 1000));
  // Cached artist pictures are not tied to a track row.
  for (const sub of ["artist", "art-car"]) {
    const cached = await env.MUSIC.list({ prefix: `families/${familyId}/${sub}/`, limit: 1000 });
    if (cached.objects.length) await env.MUSIC.delete(cached.objects.map((o) => o.key));
  }
  await env.DB.batch([
    env.DB.prepare("DELETE FROM playlist_tracks WHERE playlist_id IN (SELECT id FROM playlists WHERE family_id = ?)").bind(familyId),
    env.DB.prepare("DELETE FROM playlists WHERE family_id = ?").bind(familyId),
    env.DB.prepare("DELETE FROM ratings WHERE family_id = ?").bind(familyId),
    env.DB.prepare("DELETE FROM plays WHERE family_id = ?").bind(familyId),
    env.DB.prepare("DELETE FROM daily_mixes WHERE family_id = ?").bind(familyId),
    env.DB.prepare("DELETE FROM tracks WHERE family_id = ?").bind(familyId),
    env.DB.prepare("DELETE FROM invites WHERE family_id = ?").bind(familyId),
    env.DB.prepare("DELETE FROM families WHERE id = ?").bind(familyId),
  ]);
}

