import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";
import type { User } from "../../drizzle/schema";
import { sdk } from "./sdk";
import { ENV } from "./env";
import * as db from "../db";

export type TrpcContext = {
  req: CreateExpressContextOptions["req"];
  res: CreateExpressContextOptions["res"];
  user: User | null;
};

// Dev user for local development without OAuth
const DEV_USER_OPEN_ID = "dev-local-user";

async function getOrCreateDevUser(): Promise<User | null> {
  try {
    // Always upsert to ensure name/email stays current
    await db.upsertUser({
      openId: DEV_USER_OPEN_ID,
      name: "Optimus Admin",
      email: "admin@optimus.local",
      role: "admin",
      lastSignedIn: new Date(),
    });
    const user = await db.getUserByOpenId(DEV_USER_OPEN_ID);
    return user ?? null;
  } catch (error) {
    console.warn("[Auth] Failed to create dev user:", error);
    return null;
  }
}

export async function createContext(
  opts: CreateExpressContextOptions
): Promise<TrpcContext> {
  let user: User | null = null;

  // Auto-login a dev user when OAuth is not configured. Previously this was
  // gated on NODE_ENV === "development", but the production container serves the
  // built frontend from /app/dist (serveStatic) and MUST run NODE_ENV=production,
  // which then disabled this bypass and broke login (redirect to /login -> 404).
  // Decoupled here: if no OAuth server is configured, use the dev user regardless
  // of NODE_ENV. Set OAUTH_SERVER_URL to enable real authentication in production.
  if (!ENV.oAuthServerUrl) {
    user = await getOrCreateDevUser();
  } else {
    try {
      user = await sdk.authenticateRequest(opts.req);
    } catch (error) {
      // Authentication is optional for public procedures.
      user = null;
    }
  }

  return {
    req: opts.req,
    res: opts.res,
    user,
  };
}
