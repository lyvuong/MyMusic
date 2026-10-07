import { createRemoteJWKSet, decodeJwt, jwtVerify } from "jose";

const JWKS = createRemoteJWKSet(
  new URL("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com"),
);

export interface User {
  uid: string;
  email: string;
}

/** Verifies a Firebase ID token and checks the email against ALLOWED_EMAILS. */
export async function verifyIdToken(token: string, env: Env): Promise<User> {
  let uid: string | undefined;
  let email: string | undefined;
  if (env.AUTH_EMULATOR === "true") {
    const c = decodeJwt(token);
    uid = c.sub;
    email = c.email as string | undefined;
  } else {
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: `https://securetoken.google.com/${env.FIREBASE_PROJECT_ID}`,
      audience: env.FIREBASE_PROJECT_ID,
      algorithms: ["RS256"],
    });
    uid = payload.sub;
    email = payload.email as string | undefined;
  }
  if (!uid || !email) throw new Error("token missing sub/email");
  const allowed = env.ALLOWED_EMAILS.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  if (!allowed.includes(email.toLowerCase())) throw new Error("email not allowed");
  return { uid, email };
}
