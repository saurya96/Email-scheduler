import { createHash, randomBytes } from "node:crypto";
import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { EmailStatus, Prisma } from "@prisma/client";
import { config } from "./config.js";
import { encryptToken, googleClient, requireAuth, type AuthenticatedRequest } from "./auth.js";
import { prisma, redis } from "./services.js";
import { emailQueue, enqueueEmails } from "./queue.js";
import { indexEmail, indexEmails, searchEmails } from "./email-index.js";
import { hashPassword, verifyPassword } from "./password.js";
import sanitizeHtml from "sanitize-html";
import multer from "multer";
import {
  attachmentFromUpload,
  decryptAttachmentData,
  emailAttachmentsSchema,
  isAllowedAttachmentName,
  persistAttachment,
  readPersistedAttachment,
  removePersistedAttachment,
  type EmailAttachment,
  type UploadedAttachment
} from "./email-attachments.js";

const router = Router();
const emailUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: config.EMAIL_ATTACHMENT_MAX_FILE_SIZE_MB * 1024 * 1024,
    files: 5,
    fields: 1,
    fieldSize: 200_000
  },
  fileFilter: (_request, file, callback) => {
    if (!isAllowedAttachmentName(file.originalname)) {
      callback(new Error("Unsupported attachment file type."));
      return;
    }
    callback(null, true);
  }
});

function parseEmailUpload(request: Request, response: Response, next: NextFunction): void {
  if (!request.is("multipart/form-data")) {
    next();
    return;
  }
  emailUpload.array("attachments", 5)(request, response, (error: unknown) => {
    if (error instanceof multer.MulterError) {
      response.status(error.code === "LIMIT_FILE_SIZE" || error.code === "LIMIT_FILE_COUNT" ? 413 : 400)
        .json({
          error: error.code === "LIMIT_FILE_SIZE"
            ? `Each attachment must be ${config.EMAIL_ATTACHMENT_MAX_FILE_SIZE_MB} MB or smaller.`
            : error.code === "LIMIT_FILE_COUNT"
              ? "You can attach up to 5 files."
              : error.message
        });
      return;
    }
    if (error instanceof Error) {
      response.status(400).json({ error: error.message });
      return;
    }
    next();
  });
}

function route(
  handler: (request: Request, response: Response, next: NextFunction) => Promise<void>
) {
  return (request: Request, response: Response, next: NextFunction) => {
    void handler(request, response, next).catch(next);
  };
}

const scheduleSchema = z.object({
  recipients: z.array(z.string().trim().email()).max(10_000)
    .transform((recipients) => Array.from(new Set(recipients.map((email) => email.toLowerCase()))))
    .pipe(z.array(z.string().email()).min(1)),
  subject: z.string().trim().min(1).max(998),
  body: z.string().min(1).max(20_000),
  bodyHtml: z.string().max(50_000).optional(),
  senderId: z.string().min(1).optional(),
  attachments: emailAttachmentsSchema.default([]),
  startAt: z.string().datetime(),
  delayMs: z.number().int().min(0).max(86_400_000),
  hourlyLimit: z.number().int().positive()
}).strict();
const emailLoginSchema = z.object({
  email: z.string().trim().email().max(254).transform((email) => email.toLowerCase()),
  password: z.string().min(1).max(128)
}).strict();
const emailRegisterSchema = emailLoginSchema.extend({
  name: z.string().trim().min(1).max(100),
  password: z.string().min(10).max(128)
}).strict();

async function establishSession(request: Request, tenantId: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    request.session.regenerate((error) => error ? reject(error) : resolve());
  });
  request.session.tenantId = tenantId;
  await new Promise<void>((resolve, reject) => {
    request.session.save((error) => error ? reject(error) : resolve());
  });
}

function loginAttemptsKey(request: Request, email: string): string {
  const clientIp = request.ip || request.socket.remoteAddress || "unknown";
  const key = createHash("sha256").update(`${clientIp}\0${email}`).digest("hex");
  return `auth:login:${key}`;
}

async function allowLoginAttempt(request: Request, email: string): Promise<boolean> {
  const redisKey = loginAttemptsKey(request, email);
  const attempts = await redis.incr(redisKey);
  if (attempts === 1) await redis.expire(redisKey, 15 * 60);
  return attempts <= 10;
}

function storedAttachmentMetadata(value: Prisma.JsonValue | null | undefined): EmailAttachment[] {
  if (typeof value === "string") {
    const legacy = JSON.parse(decryptAttachmentData(value)) as Array<Omit<EmailAttachment, "id"> & { content: string }>;
    return legacy.map((attachment, index) => ({
      id: `legacy-${index}`,
      filename: attachment.filename,
      contentType: attachment.contentType,
      size: attachment.size
    }));
  }
  return emailAttachmentsSchema.parse(value ?? []).map(({ id, filename, contentType, size }) => ({
    id,
    filename,
    contentType,
    size
  }));
}

function parseLegacyAttachment(value: unknown): UploadedAttachment {
  const legacy = z.object({
    filename: z.string().min(1).max(255),
    contentType: z.string().max(127),
    size: z.number().int().positive(),
    content: z.string()
  }).strict().parse(value);
  const file = Buffer.from(legacy.content, "base64");
  if (file.length !== legacy.size || file.toString("base64") !== legacy.content) {
    throw new Error("Attachment content size does not match.");
  }
  return attachmentFromUpload({
    originalname: legacy.filename,
    mimetype: legacy.contentType,
    size: file.length,
    buffer: file
  } as Express.Multer.File);
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

router.get("/health", route(async (_request, response) => {
  await prisma.$queryRaw`SELECT 1`;
  response.json({ status: "ok" });
}));

router.get("/auth/google", (request, response) => {
  if (!config.GOOGLE_CLIENT_ID || !config.GOOGLE_CLIENT_SECRET) {
    response.status(503).json({ error: "Google OAuth is not configured" });
    return;
  }
  const state = randomBytes(24).toString("hex");
  request.session.googleState = state;
  response.redirect(googleClient.generateAuthUrl({
    access_type: "online",
    scope: ["openid", "email", "profile"],
    state,
    prompt: "select_account"
  }));
});

router.get("/auth/google/callback", route(async (request, response) => {
  const state = typeof request.query.state === "string" ? request.query.state : "";
  const code = typeof request.query.code === "string" ? request.query.code : "";
  if (!code || !state || state !== request.session.googleState) {
    response.status(400).send("Google OAuth state validation failed");
    return;
  }
  delete request.session.googleState;
  const { tokens } = await googleClient.getToken(code);
  if (!tokens.id_token) throw new Error("Google did not return an ID token");
  const ticket = await googleClient.verifyIdToken({
    idToken: tokens.id_token,
    audience: config.GOOGLE_CLIENT_ID
  });
  const profile = ticket.getPayload();
  if (!profile?.sub || !profile.email || !profile.name) {
    throw new Error("Google account did not provide a complete profile");
  }
  const tenant = await prisma.tenant.upsert({
    where: { googleSub: profile.sub },
    create: {
      googleSub: profile.sub,
      email: profile.email,
      name: profile.name,
      avatarUrl: profile.picture
    },
    update: { email: profile.email, name: profile.name, avatarUrl: profile.picture }
  });
  await establishSession(request, tenant.id);
  response.redirect(config.FRONTEND_URL);
}));

router.post("/auth/register", route(async (request, response) => {
  const input = emailRegisterSchema.parse(request.body);
  if (!await allowLoginAttempt(request, input.email)) {
    response.status(429).json({ error: "Too many account attempts. Try again in 15 minutes." });
    return;
  }
  const passwordHash = await hashPassword(input.password);
  try {
    const tenant = await prisma.tenant.create({
      data: {
        email: input.email,
        name: input.name,
        emailCredential: { create: { email: input.email, passwordHash } }
      }
    });
    await redis.del(loginAttemptsKey(request, input.email));
    await establishSession(request, tenant.id);
    response.status(201).json({ authenticated: true });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      response.status(409).json({ error: "An account with this email already exists. Log in instead." });
      return;
    }
    throw error;
  }
}));

router.post("/auth/login", route(async (request, response) => {
  const input = emailLoginSchema.parse(request.body);
  if (!await allowLoginAttempt(request, input.email)) {
    response.status(429).json({ error: "Too many login attempts. Try again in 15 minutes." });
    return;
  }
  const credential = await prisma.emailCredential.findUnique({
    where: { email: input.email },
    select: { passwordHash: true, tenantId: true }
  });
  const passwordHash = credential?.passwordHash
    ?? "scrypt$00000000000000000000000000000000$00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";
  const validPassword = await verifyPassword(input.password, passwordHash);
  if (!credential || !validPassword) {
    response.status(401).json({ error: "Email or password is incorrect." });
    return;
  }
  await redis.del(loginAttemptsKey(request, input.email));
  await establishSession(request, credential.tenantId);
  response.json({ authenticated: true });
}));

router.get("/auth/slack", requireAuth, (request: AuthenticatedRequest, response) => {
  if (!config.SLACK_CLIENT_ID || !config.SLACK_CLIENT_SECRET) {
    response.status(503).json({ error: "Slack OAuth is not configured" });
    return;
  }
  const state = randomBytes(24).toString("hex");
  request.session.slackState = state;
  const parameters = new URLSearchParams({
    client_id: config.SLACK_CLIENT_ID,
    scope: "incoming-webhook",
    redirect_uri: config.SLACK_CALLBACK_URL,
    state
  });
  response.redirect(`https://slack.com/oauth/v2/authorize?${parameters.toString()}`);
});

router.get("/auth/slack/callback", route(async (request, response) => {
  const state = typeof request.query.state === "string" ? request.query.state : "";
  const code = typeof request.query.code === "string" ? request.query.code : "";
  const tenantId = request.session.tenantId;
  if (!tenantId || !code || !state || state !== request.session.slackState) {
    response.status(400).send("Slack OAuth state validation failed");
    return;
  }
  delete request.session.slackState;
  const exchange = await fetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.SLACK_CLIENT_ID,
      client_secret: config.SLACK_CLIENT_SECRET,
      code,
      redirect_uri: config.SLACK_CALLBACK_URL
    })
  });
  if (!exchange.ok) throw new Error(`Slack OAuth exchange failed with HTTP ${exchange.status}`);
  const payload = await exchange.json() as {
    ok: boolean;
    error?: string;
    incoming_webhook?: { url: string; channel_id: string; channel: string };
  };
  if (!payload.ok || !payload.incoming_webhook?.url) {
    throw new Error(`Slack OAuth failed: ${payload.error ?? "webhook was not granted"}`);
  }
  await prisma.tenant.update({
    where: { id: tenantId },
    data: {
      slackWebhookEncrypted: encryptToken(payload.incoming_webhook.url),
      slackChannelId: payload.incoming_webhook.channel_id,
      slackChannelName: payload.incoming_webhook.channel
    }
  });
  response.redirect(`${config.FRONTEND_URL}?slack=connected`);
}));

router.get("/api/me", requireAuth, route(async (request, response) => {
  const tenant = await prisma.tenant.findUniqueOrThrow({
    where: { id: (request as AuthenticatedRequest).tenantId },
    select: { id: true, email: true, name: true, avatarUrl: true, slackChannelName: true }
  });
  response.json({
    user: {
      id: tenant.id,
      email: tenant.email,
      name: tenant.name,
      avatarUrl: tenant.avatarUrl
    },
    slackConnected: Boolean(tenant.slackChannelName),
    slackChannel: tenant.slackChannelName,
    senders: config.senders.map(({ id, email }) => ({ id, email })),
    settings: {
      minDelayMs: config.MIN_SEND_DELAY_MS,
      maxEmailsPerHourPerSender: config.MAX_EMAILS_PER_HOUR_PER_SENDER,
      attachmentMaxFileSizeBytes: config.EMAIL_ATTACHMENT_MAX_FILE_SIZE_MB * 1024 * 1024,
      attachmentMaxTotalSizeBytes: config.EMAIL_ATTACHMENT_MAX_TOTAL_SIZE_MB * 1024 * 1024
    }
  });
}));

router.post("/auth/logout", requireAuth, (request, response, next) => {
  request.session.destroy((error) => {
    if (error) return next(error);
    response.clearCookie("reachinbox.sid");
    response.status(204).end();
  });
});

router.post("/auth/slack/disconnect", requireAuth, route(async (request, response) => {
  await prisma.tenant.update({
    where: { id: (request as AuthenticatedRequest).tenantId },
    data: { slackWebhookEncrypted: null, slackChannelId: null, slackChannelName: null }
  });
  response.status(204).end();
}));

router.post("/api/emails", requireAuth, parseEmailUpload, route(async (request, response) => {
  const multipart = request.is("multipart/form-data");
  let uploadedAttachments: UploadedAttachment[] = [];
  let attachments: EmailAttachment[] = [];
  if (multipart) {
    let metadata: unknown;
    try {
      metadata = JSON.parse(request.body.metadata as string);
    } catch {
      response.status(400).json({ error: "Email metadata must contain valid JSON." });
      return;
    }
    if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
      response.status(400).json({ error: "Email metadata must be a JSON object." });
      return;
    }
    const files = (request.files ?? []) as Express.Multer.File[];
    try {
      uploadedAttachments = files.map(attachmentFromUpload);
      attachments = emailAttachmentsSchema.parse(uploadedAttachments.map(({ metadata }) => metadata));
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : "Invalid attachment." });
      return;
    }
    request.body = { ...(metadata as Record<string, unknown>), attachments };
  } else {
    try {
      uploadedAttachments = z.array(z.unknown()).max(5)
        .parse(request.body?.attachments ?? [])
        .map(parseLegacyAttachment);
      attachments = emailAttachmentsSchema.parse(uploadedAttachments.map(({ metadata }) => metadata));
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : "Invalid attachment." });
      return;
    }
    request.body = { ...request.body, attachments };
  }
  const input = scheduleSchema.parse(request.body);
  const bodyHtml = input.bodyHtml
    ? sanitizeHtml(input.bodyHtml, {
      allowedTags: ["p", "br", "strong", "b", "em", "i", "u", "ul", "ol", "li", "div"],
      allowedAttributes: { "*": ["style"], div: ["align"] },
      allowedStyles: { "*": { "text-align": [/^(left|center|right|justify)$/] } }
    })
    : undefined;
  const tenantId = (request as AuthenticatedRequest).tenantId!;
  const startAt = new Date(input.startAt);
  if (startAt.getTime() < Date.now() - 30_000) {
    response.status(400).json({ error: "Start time cannot be more than 30 seconds in the past" });
    return;
  }
  const requestKey = request.header("Idempotency-Key");
  if (!requestKey) {
    response.status(400).json({ error: "Idempotency-Key header is required" });
    return;
  }
  if (requestKey.length > 200) {
    response.status(400).json({ error: "Idempotency-Key must be 200 characters or fewer" });
    return;
  }
  if (input.senderId && !config.senders.some((sender) => sender.id === input.senderId)) {
    response.status(400).json({ error: "Selected sender account is unavailable." });
    return;
  }
  const totalAttachmentSize = uploadedAttachments.reduce((total, attachment) => total + attachment.metadata.size, 0);
  const maxTotalSize = config.EMAIL_ATTACHMENT_MAX_TOTAL_SIZE_MB * 1024 * 1024;
  if (totalAttachmentSize > maxTotalSize) {
    response.status(413).json({ error: `Attachments must total ${config.EMAIL_ATTACHMENT_MAX_TOTAL_SIZE_MB} MB or less.` });
    return;
  }
  const data = input.recipients.map((recipient, index) => ({
    tenantId,
    recipient,
    subject: input.subject,
    body: input.body,
    bodyHtml,
    scheduledAt: new Date(startAt.getTime() + index * input.delayMs),
    status: "SCHEDULED" as const,
    senderId: input.senderId ?? config.senders[index % config.senders.length]!.id,
    delayMs: input.delayMs,
    hourlyLimit: Math.min(input.hourlyLimit, config.MAX_EMAILS_PER_HOUR_PER_SENDER),
    batchId: null as string | null,
    idempotencyKey: createHash("sha256")
      .update(`${tenantId}\0${requestKey}\0${index}`)
      .digest("hex")
  }));
  const batchKey = createHash("sha256").update(`${tenantId}\0${requestKey}`).digest("hex");
  let batchId: string | undefined;
  let createdBatch = false;
  const persistedIds: string[] = [];
  try {
    let batch = await prisma.emailBatch.findUnique({ where: { idempotencyKey: batchKey } });
    if (!batch) {
      for (const upload of uploadedAttachments) {
        await persistAttachment(upload);
        persistedIds.push(upload.metadata.id);
      }
      try {
        batch = await prisma.emailBatch.create({
          data: {
            tenantId,
            idempotencyKey: batchKey,
            attachments: attachments as Prisma.InputJsonValue
          }
        });
        createdBatch = true;
      } catch (error) {
        if (!isUniqueConstraintError(error)) throw error;
        batch = await prisma.emailBatch.findUniqueOrThrow({ where: { idempotencyKey: batchKey } });
        await Promise.all(persistedIds.map(removePersistedAttachment));
        persistedIds.length = 0;
      }
    }
    batchId = batch.id;

    await prisma.email.updateMany({
      where: {
        idempotencyKey: { in: data.map((record) => record.idempotencyKey) },
        batchId: null
      },
      data: { batchId: batch.id }
    });
    for (const record of data) record.batchId = batch.id;
    for (let offset = 0; offset < data.length; offset += 500) {
      await prisma.email.createMany({ data: data.slice(offset, offset + 500), skipDuplicates: true });
    }
    const emails = await prisma.email.findMany({
      where: { idempotencyKey: { in: data.map((record) => record.idempotencyKey) } },
      orderBy: { scheduledAt: "asc" }
    });
    await enqueueEmails(emails);
    await indexEmails(emails);
    response.status(202).json({
      count: emails.length,
      emails: emails.map(({ id, recipient, subject, scheduledAt, status }) => ({
        id,
        recipient,
        subject,
        scheduledAt,
        status
      }))
    });
  } catch (error) {
    const emailCount = batchId ? await prisma.email.count({ where: { batchId } }).catch(() => 1) : 0;
    if (!emailCount) {
      if (createdBatch && batchId) await prisma.emailBatch.deleteMany({ where: { id: batchId } });
      await Promise.all(persistedIds.map(removePersistedAttachment));
    }
    throw error;
  }
}));

router.get("/api/emails/:id/attachments", requireAuth, route(async (request, response) => {
  const emailId = z.string().min(1).parse(request.params.id);
  const tenantId = (request as AuthenticatedRequest).tenantId!;
  const email = await prisma.email.findFirst({
    where: { id: emailId, tenantId },
    select: { batch: { select: { attachments: true } } }
  });
  if (!email) {
    response.status(404).json({ error: "Email not found" });
    return;
  }
  const storedAttachments = email.batch?.attachments;
  response.json({ attachments: storedAttachmentMetadata(storedAttachments) });
}));

router.get("/api/emails/:id/attachments/:attachmentId", requireAuth, route(async (request, response) => {
  const emailId = z.string().min(1).parse(request.params.id);
  const attachmentId = z.string().min(1).parse(request.params.attachmentId);
  const tenantId = (request as AuthenticatedRequest).tenantId!;
  const email = await prisma.email.findFirst({
    where: { id: emailId, tenantId },
    select: { batch: { select: { attachments: true } } }
  });
  if (!email?.batch) {
    response.status(404).json({ error: "Attachment not found" });
    return;
  }

  const stored = email.batch.attachments;
  let attachment: EmailAttachment | undefined;
  let content: Buffer;
  if (typeof stored === "string" && attachmentId.startsWith("legacy-")) {
    const legacy = JSON.parse(decryptAttachmentData(stored)) as Array<Omit<EmailAttachment, "id"> & { content: string }>;
    const index = Number(attachmentId.slice("legacy-".length));
    const item = Number.isInteger(index) && index >= 0 ? legacy[index] : undefined;
    if (!item) {
      response.status(404).json({ error: "Attachment not found" });
      return;
    }
    attachment = { id: attachmentId, filename: item.filename, contentType: item.contentType, size: item.size };
    content = Buffer.from(item.content, "base64");
  } else {
    const metadata = emailAttachmentsSchema.parse(stored);
    attachment = metadata.find((item) => item.id === attachmentId);
    if (!attachment || "content" in attachment) {
      response.status(404).json({ error: "Attachment not found" });
      return;
    }
    try {
      content = await readPersistedAttachment(attachment.id);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        response.status(404).json({ error: "Attachment file is no longer available" });
        return;
      }
      throw error;
    }
  }

  if (!attachment || content.length !== attachment.size) {
    throw new Error("Stored attachment size does not match its metadata.");
  }
  const inline = request.query.inline === "1"
    && (attachment.contentType.startsWith("image/") && attachment.contentType !== "image/svg+xml"
      || attachment.contentType === "application/pdf");
  const safeFilename = attachment.filename.replace(/["\\\r\n]/g, "_");
  response.setHeader("Content-Type", attachment.contentType);
  response.setHeader("Content-Length", content.length);
  response.setHeader("Content-Disposition", `${inline ? "inline" : "attachment"}; filename="${safeFilename}"; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`);
  response.setHeader("Cache-Control", "private, no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
  response.end(content);
}));

router.post("/api/emails/:id/star", requireAuth, route(async (request, response) => {
  const input = z.object({ starred: z.boolean() }).strict().parse(request.body);
  const emailId = z.string().min(1).parse(request.params.id);
  const tenantId = (request as AuthenticatedRequest).tenantId!;
  const updated = await prisma.email.updateMany({
    where: { id: emailId, tenantId },
    data: { starred: input.starred }
  });
  if (!updated.count) {
    response.status(404).json({ error: "Email not found" });
    return;
  }
  const email = await prisma.email.findFirstOrThrow({ where: { id: emailId, tenantId } });
  await indexEmail(email);
  response.json({ starred: email.starred });
}));

router.delete("/api/emails/:id", requireAuth, route(async (request, response) => {
  const emailId = z.string().min(1).parse(request.params.id);
  const tenantId = (request as AuthenticatedRequest).tenantId!;
  const cancelled = await prisma.email.updateMany({
    where: { id: emailId, tenantId, status: EmailStatus.SCHEDULED },
    data: { status: EmailStatus.CANCELLED, error: "Cancelled by user" }
  });
  if (!cancelled.count) {
    response.status(409).json({ error: "This email is no longer scheduled and cannot be cancelled." });
    return;
  }
  const job = await emailQueue.getJob(emailId);
  if (job) {
    const state = await job.getState();
    if (state !== "active") await job.remove();
  }
  const email = await prisma.email.findFirstOrThrow({ where: { id: emailId, tenantId } });
  await indexEmail(email);
  response.status(204).end();
}));

router.get("/api/emails", requireAuth, route(async (request, response) => {
  const tenantId = (request as AuthenticatedRequest).tenantId!;
  const view = request.query.view === "sent" ? "sent" : "scheduled";
  const query = typeof request.query.q === "string" ? request.query.q.trim().slice(0, 200) : "";
  const page = request.query.page === undefined ? 1 : Number(request.query.page);
  if (!Number.isInteger(page) || page < 1 || page > 100) {
    response.status(400).json({ error: "page must be an integer between 1 and 100" });
    return;
  }
  const pageSize = 100;
  const skip = (page - 1) * pageSize;
  const statuses: EmailStatus[] = view === "sent"
    ? [EmailStatus.SENT, EmailStatus.FAILED]
    : [EmailStatus.SCHEDULED, EmailStatus.SENDING];
  if (query) {
    const ids = await searchEmails(tenantId, query, pageSize + 1, skip, view);
    if (ids.length === 0) {
      response.json({ emails: [], hasMore: false });
      return;
    }
    const pageIds = ids.slice(0, pageSize);
    const matches = await prisma.email.findMany({
      where: { tenantId, status: { in: statuses }, id: { in: pageIds } },
      orderBy: view === "sent" ? { sentAt: "desc" } : { scheduledAt: "asc" }
    });
    const order = new Map(pageIds.map((id, index) => [id, index]));
    matches.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    response.json({ emails: matches, hasMore: ids.length > pageSize });
    return;
  }
  const rows = await prisma.email.findMany({
    where: { tenantId, status: { in: statuses } },
    orderBy: view === "sent" ? { sentAt: "desc" } : { scheduledAt: "asc" },
    skip,
    take: pageSize + 1
  });
  response.json({ emails: rows.slice(0, pageSize), hasMore: rows.length > pageSize });
}));

export default router;
