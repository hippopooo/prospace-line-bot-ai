import { Redis } from '@upstash/redis';

export type ChatTurn = { role: 'user' | 'bot'; text: string };

// Keep the last few messages per user so follow-up answers ("20 คน", "ขอราคา") keep their context.
const MAX_MESSAGES = 10;
const TTL_SECONDS = 60 * 60;
const TIMEOUT_MS = 1_000;

let redis: Redis | null | undefined;

// Vercel's Upstash integration sets KV_REST_API_*; a direct Upstash setup uses UPSTASH_REDIS_REST_*.
function getRedis(): Redis | null {
  if (redis === undefined) {
    const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
    if (url && token) {
      redis = new Redis({ url, token });
    } else {
      console.warn('[HISTORY] Redis is not configured, conversation history disabled');
      redis = null;
    }
  }
  return redis;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function keyFor(userId: string): string {
  // v2: drops histories saved before DEFAULT_REPLY turns were excluded.
  return `history:v2:${userId}`;
}

export async function getHistory(userId: string | undefined): Promise<ChatTurn[]> {
  const client = getRedis();
  if (!client || !userId) {
    return [];
  }
  try {
    // The client deserializes the JSON objects stored by appendHistory.
    return await withTimeout(client.lrange<ChatTurn>(keyFor(userId), 0, -1), TIMEOUT_MS);
  } catch (err) {
    console.error('[HISTORY] read failed:', err instanceof Error ? err.message : String(err));
    return [];
  }
}

export async function appendHistory(
  userId: string | undefined,
  userText: string,
  botText: string,
): Promise<void> {
  const client = getRedis();
  if (!client || !userId) {
    return;
  }
  const key = keyFor(userId);
  try {
    await withTimeout(
      client
        .pipeline()
        .rpush(key, { role: 'user', text: userText }, { role: 'bot', text: botText })
        .ltrim(key, -MAX_MESSAGES, -1)
        .expire(key, TTL_SECONDS)
        .exec(),
      TIMEOUT_MS,
    );
  } catch (err) {
    console.error('[HISTORY] write failed:', err instanceof Error ? err.message : String(err));
  }
}
