import nodemailer from "nodemailer";
import { DelayedError, Worker, type Job } from "bullmq";
import { config } from "./config.js";
import { closeServices, prisma, redis } from "./services.js";
import { emailQueue, EMAIL_QUEUE_NAME, type EmailJob, enqueueEmails } from "./queue.js";
import {
  reserveSendSlot,
  claimRateLimitNotification,
  releaseRateLimitNotification
} from "./rate-limit.js";
import { sendRateLimitAlert } from "./slack.js";
import { indexEmail } from "./email-index.js";
import { decryptAttachmentData, emailAttachmentsSchema, readPersistedAttachment } from "./email-attachments.js";

const transports = new Map(config.senders.map((sender) => [
  sender.id,
  nodemailer.createTransport({
    host: sender.host,
    port: sender.port,
    secure: sender.secure,
    auth: { user: sender.user, pass: sender.pass }
  })
]));
const senderById = new Map(config.senders.map((sender) => [sender.id, sender]));

async function processEmail(job: Job<EmailJob>): Promise<void> {
  let email = await prisma.email.findUnique({ where: { id: job.data.emailId } });
  if (!email || email.status === "SENT" || email.status === "FAILED" || email.status === "CANCELLED") return;
  if (email.status === "SENDING") {
    const leaseAge = Date.now() - email.updatedAt.getTime();
    const leaseMs = 10 * 60_000;
    if (leaseAge < leaseMs) {
      await job.moveToDelayed(Date.now() + leaseMs - leaseAge, job.token);
      throw new DelayedError();
    }
    const recovered = await prisma.email.updateMany({
      where: { id: email.id, status: "SENDING", updatedAt: email.updatedAt },
      data: { status: "SCHEDULED", error: "Recovered after a worker interruption" }
    });
    if (recovered.count === 0) return;
    email = await prisma.email.findUnique({ where: { id: email.id } });
    if (!email) return;
  }
  const sender = senderById.get(email.senderId);
  const transport = transports.get(email.senderId);
  if (!sender || !transport) throw new Error(`No SMTP configuration for sender ${email.senderId}`);

  const batch = email.batchId
    ? await prisma.emailBatch.findUnique({ where: { id: email.batchId }, select: { attachments: true } })
    : null;
  const storedAttachments = typeof batch?.attachments === "string"
    ? JSON.parse(decryptAttachmentData(batch.attachments)) as unknown
    : batch?.attachments ?? [];
  const parsedAttachments = emailAttachmentsSchema.parse(storedAttachments);
  const attachments = await Promise.all(parsedAttachments.map(async (attachment) => ({
    filename: attachment.filename,
    contentType: attachment.contentType,
    content: "content" in attachment
      ? Buffer.from(attachment.content, "base64")
      : await readPersistedAttachment(attachment.id)
  })));
  if (attachments.some((attachment, index) => attachment.content.length !== parsedAttachments[index]?.size)) {
    throw new Error("Stored email attachment size does not match its metadata.");
  }

  const limit = Math.min(email.hourlyLimit, config.MAX_EMAILS_PER_HOUR_PER_SENDER);
  const reservation = await reserveSendSlot(
    email.tenantId,
    email.senderId,
    limit,
    config.MAX_EMAILS_PER_HOUR_PER_SENDER,
    Math.max(email.delayMs, config.MIN_SEND_DELAY_MS)
  );
  if (reservation.limited) {
    if (await claimRateLimitNotification(email.tenantId, email.senderId)) {
      try {
        const notified = await sendRateLimitAlert(email.tenantId, sender.email, limit);
        if (!notified) await releaseRateLimitNotification(email.tenantId, email.senderId);
      } catch (error) {
        await releaseRateLimitNotification(email.tenantId, email.senderId);
        console.error(`Slack rate-limit alert failed for ${email.senderId}:`, error);
      }
    }
    await job.moveToDelayed(Date.now() + reservation.waitMs, job.token);
    throw new DelayedError();
  }
  if (reservation.waitMs > 0) {
    await job.moveToDelayed(Date.now() + reservation.waitMs, job.token);
    throw new DelayedError();
  }

  const claim = await prisma.email.updateMany({
    where: { id: email.id, status: "SCHEDULED" },
    data: { status: "SENDING", error: null }
  });
  if (claim.count === 0) return;

  let sent: Awaited<ReturnType<typeof transport.sendMail>>;
  try {
    sent = await transport.sendMail({
      from: sender.email,
      to: email.recipient,
      subject: email.subject,
      text: email.body,
      ...(email.bodyHtml ? { html: email.bodyHtml } : {}),
      ...(attachments.length ? { attachments } : {}),
      messageId: `<${email.id}@reachinbox.local>`
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "SMTP delivery failed";
    await prisma.email.update({
      where: { id: email.id },
      data: { status: "SCHEDULED", error: message }
    });
    throw error;
  }
  const updated = await prisma.email.update({
    where: { id: email.id },
    data: { status: "SENT", sentAt: new Date(), error: null }
  });
  await indexEmail(updated);
  const preview = nodemailer.getTestMessageUrl(sent);
  if (preview) console.info(`Ethereal preview for ${email.id}: ${preview}`);
}

async function syncPendingEmails(): Promise<void> {
  await prisma.email.updateMany({
    where: {
      status: "SENDING",
      updatedAt: { lt: new Date(Date.now() - 10 * 60_000) }
    },
    data: { status: "SCHEDULED", error: "Recovered after a worker interruption" }
  });
  const recovered = await prisma.email.findMany({
    where: { status: "SCHEDULED" },
    select: { id: true, scheduledAt: true }
  });
  await enqueueEmails(recovered);
}

const worker = new Worker<EmailJob>(EMAIL_QUEUE_NAME, processEmail, {
  connection: redis,
  concurrency: config.WORKER_CONCURRENCY
});

worker.on("failed", (job, error) => {
  if (!job) return;
  void (async () => {
    console.error(`Job ${job.id} failed:`, error);
    if (job.attemptsMade >= (job.opts.attempts ?? 1)) {
      const email = await prisma.email.updateMany({
        where: { id: job.data.emailId, status: "SCHEDULED" },
        data: { status: "FAILED", error: error.message }
      });
      if (email.count) {
        const record = await prisma.email.findUnique({ where: { id: job.data.emailId } });
        if (record) await indexEmail(record);
      }
    }
  })().catch((failure: unknown) => console.error("Unable to update failed email status:", failure));
});

worker.on("error", (error) => console.error("BullMQ worker error:", error));

try {
  await syncPendingEmails();
  console.info(`Email worker ready with concurrency ${config.WORKER_CONCURRENCY}`);
} catch (error) {
  console.error("Unable to restore scheduled email jobs", error);
  await worker.close();
  await emailQueue.close();
  await closeServices();
  process.exitCode = 1;
}

async function shutdown(): Promise<void> {
  await worker.close();
  await emailQueue.close();
  await closeServices();
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
