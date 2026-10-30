import { redis } from "./services.js";

const reserveScript = `
local now = tonumber(ARGV[1])
local minDelay = tonumber(ARGV[2])
local tenantLimit = tonumber(ARGV[3])
local senderLimit = tonumber(ARGV[4])
local nextHour = tonumber(ARGV[5])

local tenantSent = tonumber(redis.call("GET", KEYS[1]) or "0")
local senderSent = tonumber(redis.call("GET", KEYS[2]) or "0")

-- Respect both the tenant's selected cap and the shared SMTP sender cap.
if tenantSent >= tenantLimit or senderSent >= senderLimit then
 return {1, nextHour - now}
end

-- Check the sender's next available send time before reserving either quota.
local nextAllowed = tonumber(redis.call("GET", KEYS[3]) or "0")
if nextAllowed > now then
 return {0, nextAllowed - now}
end

-- Reserve both hourly slots atomically across worker processes.
redis.call("INCR", KEYS[1])
redis.call("EXPIRE", KEYS[1], 7200)
redis.call("INCR", KEYS[2])
redis.call("EXPIRE", KEYS[2], 7200)
redis.call("SET", KEYS[3], now + minDelay)

return {0, 0}
`;

export interface Reservation {
  limited: boolean;
  waitMs: number;
}

export async function reserveSendSlot(
  tenantId: string,
  senderId: string,
  limit: number,
  senderLimit: number,
  minimumDelayMs: number
): Promise<Reservation> {
  const now = Date.now();
  const hourStart = Math.floor(now / 3_600_000) * 3_600_000;

  const tenantCountKey = `email-rate:tenant:${tenantId}:${senderId}:${hourStart}`;
  const senderCountKey = `email-rate:sender:${senderId}:${hourStart}`;
  const nextSendKey = "email-rate:global-next-send";

  const result = await redis.eval(
    reserveScript,
    3,
    tenantCountKey,
    senderCountKey,
    nextSendKey,
    now,
    minimumDelayMs,
    limit,
    senderLimit,
    hourStart + 3_600_000
  ) as [number, number];

  return {
    limited: result[0] === 1,
    waitMs: Math.max(0, result[1])
  };
}

export async function claimRateLimitNotification(
  tenantId: string,
  senderId: string
): Promise<boolean> {
  const window = Math.floor(Date.now() / 3_600_000);

  const result = await redis.set(
    `email-rate-notified:${tenantId}:${senderId}:${window}`,
    "1",
    "EX",
    7200,
    "NX"
  );

  return result === "OK";
}

export async function releaseRateLimitNotification(
  tenantId: string,
  senderId: string
): Promise<void> {
  const window = Math.floor(Date.now() / 3_600_000);

  await redis.del(
    `email-rate-notified:${tenantId}:${senderId}:${window}`
  );
}
