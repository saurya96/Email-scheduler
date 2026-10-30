import "dotenv/config";
import { z } from "zod";

const senderSchema = z.object({
  id: z.string().min(1),
  email: z.string().email(),
  host: z.string().min(1),
  port: z.number().int().positive(),
  secure: z.boolean(),
  user: z.string().min(1),
  pass: z.string().min(1)
});

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  FRONTEND_URL: z.string().url().default("http://localhost:5173"),
  API_URL: z.string().url().default("http://localhost:4000"),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().url(),
  ELASTICSEARCH_URL: z.string().url(),
  SESSION_SECRET: z.string().min(32),
  TOKEN_ENCRYPTION_KEY: z.string().regex(/^[a-fA-F0-9]{64}$/),
  GOOGLE_CLIENT_ID: z.string().optional().default(""),
  GOOGLE_CLIENT_SECRET: z.string().optional().default(""),
  GOOGLE_CALLBACK_URL: z.string().url(),
  SLACK_CLIENT_ID: z.string().optional().default(""),
  SLACK_CLIENT_SECRET: z.string().optional().default(""),
  SLACK_CALLBACK_URL: z.string().url(),
  SMTP_SENDERS: z.string().default("[]"),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(5),
  MIN_SEND_DELAY_MS: z.coerce.number().int().nonnegative().default(2000),
  MAX_EMAILS_PER_HOUR_PER_SENDER: z.coerce.number().int().positive().default(200),
  EMAIL_ATTACHMENT_STORAGE_DIR: z.string().min(1).default("./data/email-attachments"),
  EMAIL_ATTACHMENT_MAX_FILE_SIZE_MB: z.coerce.number().int().positive().max(25).default(10),
  EMAIL_ATTACHMENT_MAX_TOTAL_SIZE_MB: z.coerce.number().int().positive().max(50).default(20),
  CORS_ORIGIN: z.string().url().default("http://localhost:5173")
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  throw new Error(`Invalid environment configuration: ${parsed.error.message}`);
}

const senders = z.array(senderSchema).parse(JSON.parse(parsed.data.SMTP_SENDERS));
if (senders.length === 0) {
  throw new Error("SMTP_SENDERS must contain at least one configured sender");
}
if (new Set(senders.map((sender) => sender.id)).size !== senders.length) {
  throw new Error("SMTP sender IDs must be unique");
}

export const config = { ...parsed.data, senders };
