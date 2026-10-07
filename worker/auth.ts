import { createRemoteJWKSet, decodeJwt, jwtVerify } from "jose";

const JWKS = createRemoteJWKSet(
  new URL("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com"),
);

export interface User {
  uid: string;
  email: string;
  name: string;
}

/** Verifies a Firebase Auth ID token (Google, Apple, ... any provider the Firebase project enables). */
export async function verifyIdToken(token: string, env: Env): Promise<User> {
  let claims: Record<string, unknown>;
  if (env.AUTH_EMULATOR === "true") {
    claims = decodeJwt(token); // the emulator issues unsigned tokens (local dev only)
  } else {
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: `https://securetoken.google.com/${env.FIREBASE_PROJECT_ID}`,
      audience: env.FIREBASE_PROJECT_ID,
      algorithms: ["RS256"],
    });
    claims = payload;
  }
  if (typeof claims.sub !== "string") throw new Error("token missing sub");
  return {
    uid: claims.sub,
    email: typeof claims.email === "string" ? claims.email : "",
    name: typeof claims.name === "string" ? claims.name : "",
  };
}
