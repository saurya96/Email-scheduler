import type { Email } from "@prisma/client";
import { errors } from "@elastic/elasticsearch";
import { elastic } from "./services.js";

const INDEX = "scheduled-emails";
let indexReady: Promise<void> | undefined;

async function ensureIndex(): Promise<void> {
  if (!indexReady) {
    indexReady = elastic.indices.create({
      index: INDEX,
      mappings: {
        properties: {
          tenantId: { type: "keyword" },
          recipient: { type: "text", fields: { keyword: { type: "keyword" } } },
          subject: { type: "text" },
          body: { type: "text" },
          status: { type: "keyword" },
          scheduledAt: { type: "date" },
          sentAt: { type: "date" },
          senderId: { type: "keyword" }
        }
      }
    }).then(() => undefined).catch((error: unknown) => {
      if (
        error instanceof errors.ResponseError
        && error.statusCode === 400
        && error.body?.error?.type === "resource_already_exists_exception"
      ) {
        return;
      }
      indexReady = undefined;
      throw error;
    });
  }
  await indexReady;
}

export async function indexEmail(email: Email): Promise<void> {
  await indexEmails([email]);
}

export async function indexEmails(emails: Email[]): Promise<void> {
  await ensureIndex();
  for (let offset = 0; offset < emails.length; offset += 250) {
    const operations = emails.slice(offset, offset + 250).flatMap((email) => [
      { index: { _index: INDEX, _id: email.id } },
      {
        tenantId: email.tenantId,
        recipient: email.recipient,
        subject: email.subject,
        body: email.body,
        status: email.status,
        scheduledAt: email.scheduledAt,
        sentAt: email.sentAt,
        senderId: email.senderId
      }
    ]);
    const result = await elastic.bulk({ operations, refresh: "wait_for" });
    if (result.errors) {
      const failure = result.items.find((item) => item.index?.error)?.index?.error;
      throw new Error(`Elasticsearch indexing failed: ${failure?.reason ?? "bulk request contained errors"}`);
    }
  }
}

export async function searchEmails(
  tenantId: string,
  query: string,
  limit: number,
  offset: number,
  view: "scheduled" | "sent"
) {
  await ensureIndex();
  const statuses = view === "sent" ? ["SENT", "FAILED"] : ["SCHEDULED", "SENDING"];
  const result = await elastic.search({
    index: INDEX,
    size: limit,
    from: offset,
    query: {
      bool: {
        filter: [{ term: { tenantId } }, { terms: { status: statuses } }],
        must: query ? [{
          multi_match: {
            query,
            fields: ["recipient^3", "subject^2", "body"],
            type: "best_fields"
          }
        }] : [{ match_all: {} }]
      }
    },
    sort: [{ [view === "scheduled" ? "scheduledAt" : "sentAt"]: view === "scheduled" ? "asc" : "desc" }]
  });
  return result.hits.hits.map((hit) => hit._id).filter((id): id is string => Boolean(id));
}
