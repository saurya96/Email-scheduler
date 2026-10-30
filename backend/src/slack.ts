import { decryptToken } from "./auth.js";
import { prisma } from "./services.js";

export async function sendRateLimitAlert(
  tenantId: string,
  senderEmail: string,
  limit: number
): Promise<boolean> {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant?.slackWebhookEncrypted) return false;
  const webhook = decryptToken(tenant.slackWebhookEncrypted);
  const result = await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      text: `Hourly email limit reached for ${senderEmail} (${limit} emails). Remaining emails will resume in the next hour window.`
    })
  });
  if (!result.ok) {
    throw new Error(`Slack notification failed with HTTP ${result.status}`);
  }
  const responseBody = await result.text();
  if (responseBody !== "ok") {
    throw new Error(`Slack notification failed: ${responseBody || "empty response"}`);
  }
  return true;
}
