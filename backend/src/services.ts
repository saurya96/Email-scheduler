import { PrismaClient } from "@prisma/client";
import { Redis } from "ioredis";
import { Client } from "@elastic/elasticsearch";
import { config } from "./config.js";

export const prisma = new PrismaClient();
export const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
export const elastic = new Client({
  node: config.ELASTICSEARCH_URL,
  auth: {
    apiKey: config.ELASTICSEARCH_API_KEY
  }
});
export async function closeServices(): Promise<void> {
  await Promise.all([prisma.$disconnect(), redis.quit(), elastic.close()]);
}
