import { HTTPFetchError, messagingApi, validateSignature, webhook } from '@line/bot-sdk';
import { GEMINI_TIMEOUT_MS, askGemini } from '@/lib/gemini';
import { CONTACT_RECEIVED_REPLY, DEFAULT_REPLY, GREETING } from '@/lib/messages';
import { getFaqCsv } from '@/lib/sheet';

export const runtime = 'nodejs';
export const maxDuration = 15;

// Everything (Sheet 3s + Gemini 7s) must finish within this budget.
const TOTAL_BUDGET_MS = 10_000;
// Below this, a Gemini call is not worth starting.
const MIN_GEMINI_MS = 1_000;

const PHONE_PATTERN = /0\d{8,9}|\+66\d{8,9}/;

let lineClient: messagingApi.MessagingApiClient | null = null;

function getLineClient(): messagingApi.MessagingApiClient {
  if (!lineClient) {
    lineClient = new messagingApi.MessagingApiClient({
      channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN ?? '',
    });
  }
  return lineClient;
}

function hasPhoneNumber(text: string): boolean {
  return PHONE_PATTERN.test(text.replace(/[-\s]/g, ''));
}

async function reply(replyToken: string, text: string): Promise<void> {
  try {
    await getLineClient().replyMessage({
      replyToken,
      messages: [{ type: 'text', text }],
    });
  } catch (err) {
    if (err instanceof HTTPFetchError) {
      console.error('[LINE] reply failed:', { status: err.status, body: err.body });
    } else {
      console.error('[LINE] reply failed:', err instanceof Error ? err.message : String(err));
    }
  }
}

async function answerText(text: string, startedAt: number): Promise<string> {
  const faq = await getFaqCsv();
  if (faq === null) {
    return DEFAULT_REPLY;
  }

  const remaining = TOTAL_BUDGET_MS - (Date.now() - startedAt);
  const geminiTimeout = Math.min(GEMINI_TIMEOUT_MS, remaining);
  if (geminiTimeout < MIN_GEMINI_MS) {
    console.warn('[GEMINI] skipped, time budget exhausted:', { remainingMs: remaining });
    return DEFAULT_REPLY;
  }
  return askGemini(faq, text, geminiTimeout);
}

async function handleEvent(event: webhook.Event, startedAt: number): Promise<void> {
  if (event.deliveryContext?.isRedelivery === true) {
    console.log('[LINE] skip redelivery:', event.webhookEventId);
    return;
  }

  if (event.type === 'follow') {
    await reply(event.replyToken, GREETING);
    return;
  }

  if (event.type !== 'message' || !event.replyToken) {
    return;
  }

  if (event.message.type !== 'text') {
    await reply(event.replyToken, DEFAULT_REPLY);
    return;
  }

  const text = event.message.text;
  if (hasPhoneNumber(text)) {
    console.log('[CALLBACK_REQUEST]', event.source?.userId, text);
    await reply(event.replyToken, CONTACT_RECEIVED_REPLY);
    return;
  }

  await reply(event.replyToken, await answerText(text, startedAt));
}

export async function POST(req: Request): Promise<Response> {
  const startedAt = Date.now();
  const body = await req.text();
  const signature = req.headers.get('x-line-signature') ?? '';

  if (!signature || !validateSignature(body, process.env.LINE_CHANNEL_SECRET ?? '', signature)) {
    console.warn('[LINE] invalid signature');
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    const { events } = JSON.parse(body) as webhook.CallbackRequest;
    if (!events || events.length === 0) {
      return new Response('OK', { status: 200 });
    }
    await Promise.all(
      events.map((event) =>
        handleEvent(event, startedAt).catch((err) => {
          console.error('[LINE] event handling failed:', err instanceof Error ? err.message : String(err));
        }),
      ),
    );
  } catch (err) {
    console.error('[LINE] webhook processing failed:', err instanceof Error ? err.message : String(err));
  }

  return new Response('OK', { status: 200 });
}
