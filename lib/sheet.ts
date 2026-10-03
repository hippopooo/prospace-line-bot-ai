const CACHE_TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = 3_000;

let cachedCsv: string | null = null;
let cachedAt = 0;

export async function getFaqCsv(): Promise<string | null> {
  if (cachedCsv !== null && Date.now() - cachedAt < CACHE_TTL_MS) {
    return cachedCsv;
  }

  const url = process.env.SHEET_CSV_URL;
  if (!url) {
    console.error('[SHEET] SHEET_CSV_URL is not set');
    return cachedCsv;
  }

  try {
    const res = await fetch(url, {
      cache: 'no-store',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const csv = (await res.text()).trim();
    if (!csv) {
      throw new Error('empty CSV');
    }
    cachedCsv = csv;
    cachedAt = Date.now();
    return csv;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    if (cachedCsv !== null) {
      console.warn('[SHEET] fetch failed, using stale cache:', reason);
      return cachedCsv;
    }
    console.error('[SHEET] fetch failed, no cache available:', reason);
    return null;
  }
}
