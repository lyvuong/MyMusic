/**
 * Signed media URLs for Google Cast. A cast device fetches the audio and cover itself and cannot send the user's login
 * token, so the Worker hands out URLs that carry an HMAC over (kind, track id, family, expiry). A URL grants access to
 * that one track's audio or cover until it expires, nothing else.
 */

const TTL_SECONDS = 12 * 3600;
let keyCache: CryptoKey | null = null;

const b64url = (buf: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

/** The signing key lives in D1, generated on first use, so no secret has to be configured by hand. */
async function signingKey(db: D1Database): Promise<CryptoKey> {
  if (keyCache) return keyCache;
  let row = await db.prepare("SELECT value FROM app_secrets WHERE name = 'cast'").first<{ value: string }>();
  if (!row) {
    const fresh = [...crypto.getRandomValues(new Uint8Array(32))].map((x) => x.toString(16).padStart(2, "0")).join("");
    await db.prepare("INSERT OR IGNORE INTO app_secrets (name, value) VALUES ('cast', ?)").bind(fresh).run();
    row = await db.prepare("SELECT value FROM app_secrets WHERE name = 'cast'").first<{ value: string }>();
  }
  keyCache = await crypto.subtle.importKey("raw", new TextEncoder().encode(row!.value), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  return keyCache;
}

const message = (kind: string, id: string, family: string, exp: number) => new TextEncoder().encode(`${kind}|${id}|${family}|${exp}`);

/** The query string that makes /api/<kind>/<id> readable without a login. */
export async function signedQuery(db: D1Database, kind: "stream" | "art", id: string, family: string) {
  const exp = Math.floor(Date.now() / 1000) + TTL_SECONDS;
  const sig = await crypto.subtle.sign("HMAC", await signingKey(db), message(kind, id, family, exp));
  return `fam=${encodeURIComponent(family)}&exp=${exp}&sig=${b64url(sig)}`;
}

export async function verifySigned(db: D1Database, kind: string, id: string, family: string, exp: number, sig: string): Promise<boolean> {
  if (!Number.isFinite(exp) || exp < Date.now() / 1000) return false;
  try {
    return await crypto.subtle.verify("HMAC", await signingKey(db), fromB64url(sig), message(kind, decodeURIComponent(id), family, exp));
  } catch {
    return false;
  }
}
