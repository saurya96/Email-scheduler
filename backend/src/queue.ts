import { Queue } from "bullmq";
import { redis } from "./services.js";

export const EMAIL_QUEUE_NAME = "scheduled-emails";
export const emailQueue = new Queue(EMAIL_QUEUE_NAME, { connection: redis });

export interface EmailJob {
  emailId: string;
}

export async function enqueueEmails(
  emails: Array<{ id: string; scheduledAt: Date }>
): Promise<void> {
  for (let offset = 0; offset < emails.length; offset += 500) {
    const now = Date.now();
    const batch = emails.slice(offset, offset + 500);
    await emailQueue.addBulk(batch.map(({ id, scheduledAt }) => ({
      name: "send-email",
      data: { emailId: id } satisfies EmailJob,
      opts: {
        jobId: id,
        delay: Math.max(0, scheduledAt.getTime() - now),
        attempts: 5,
        backoff: { type: "exponential", delay: 5000 },
        removeOnComplete: { age: 86400, count: 10000 },
        removeOnFail: { age: 604800, count: 10000 }
      }
    })));
  }
}
