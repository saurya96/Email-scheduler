import "express-session";

declare module "express-session" {
  interface SessionData {
    tenantId?: string;
    googleState?: string;
    slackState?: string;
  }
}
