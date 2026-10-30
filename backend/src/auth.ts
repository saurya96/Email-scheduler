import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { OAuth2Client } from "google-auth-library";
import { config } from "./config.js";
import { prisma } from "./services.js";

export interface AuthenticatedRequest extends Request {
  tenantId?: string;
}

export const googleClient = new OAuth2Client(
  config.GOOGLE_CLIENT_ID,
  config.GOOGLE_CLIENT_SECRET,
  config.GOOGLE_CALLBACK_URL
);

export function requireAuth(
  request: AuthenticatedRequest,
  response: Response,
  next: NextFunction
): void {
  const tenantId = request.session.tenantId;
  if (!tenantId) {
    response.status(401).json({ error: "Authentication required" });
    return;
  }
  request.tenantId = tenantId;
  next();
}

export function encryptToken(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(config.TOKEN_ENCRYPTION_KEY, "hex"), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `${iv.toString("hex")}.${cipher.getAuthTag().toString("hex")}.${encrypted.toString("hex")}`;
}

export function decryptToken(value: string): string {
  const [ivHex, tagHex, contentHex] = value.split(".");
  if (!ivHex || !tagHex || !contentHex) throw new Error("Stored Slack credential is malformed");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    Buffer.from(config.TOKEN_ENCRYPTION_KEY, "hex"),
    Buffer.from(ivHex, "hex")
  );
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([
    decipher.update(Buffer.from(contentHex, "hex")),
    decipher.final()
  ]).toString("utf8");
}
