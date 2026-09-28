import fetch from 'cross-fetch';
import debug from 'debug';
import { CHROME_SEC_CH_UA, CHROME_USER_AGENT } from './api';

const log = debug('twitter-scraper:xctxid');

// @ts-expect-error import type annotation ("the current file is a CommonJS module")
type LinkeDOM = typeof import('linkedom');

let linkedom: LinkeDOM | null = null;
async function linkedomImport(): Promise<LinkeDOM> {
  if (!linkedom) {
    const mod = await import('linkedom');
    linkedom = mod;
    return mod;
  }
  return linkedom;
}

async function parseHTML(html: string): Promise<Window & typeof globalThis> {
  if (typeof window !== 'undefined') {
    const { defaultView } = new DOMParser().parseFromString(html, 'text/html');
    if (!defaultView) {
      throw new Error('Failed to get defaultView from parsed HTML.');
    }
    return defaultView;
  } else {
    const { DOMParser } = await linkedomImport();
    return new DOMParser().parseFromString(html, 'text/html').defaultView;
  }
}

// Copied from https://github.com/Lqm1/x-client-transaction-id/blob/main/utils.ts with minor tweaks to support us passing a custom fetch function
async function handleXMigration(fetchFn: typeof fetch): Promise<Document> {
  return fetchXDocument(fetchFn);
}

async function fetchXDocument(fetchFn: typeof fetch): Promise<Document> {
  // Set headers to mimic a browser request
  const headers = {
    accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
    "accept-language": "ja",
    "cache-control": "no-cache",
    pragma: "no-cache",
    priority: "u=0, i",
    "sec-ch-ua":
      '"Google Chrome";v="135", "Not-A.Brand";v="8", "Chromium";v="135"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": "none",
    "sec-fetch-user": "?1",
    "upgrade-insecure-requests": "1",
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
  };

  // Fetch the responsive web app shell. The bare x.com homepage can serve a
  // separate logged-out app that no longer includes the ondemand chunk map.
  const response = await fetchFn('https://x.com/home', {
    headers,
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch X homepage: ${response.statusText}`);
  }

  const htmlText = await response.text();

  // Parse HTML using linkedom
  const dom = await parseHTML(htmlText);
  const document = dom.window.document;

  // Return the DOM document
  return document;
}

// Cache for the x.com document to avoid repeated fetches.
// The document is needed to generate transaction IDs but doesn't change frequently.
// We cache the Promise (not the result) to prevent concurrent calls from all fetching separately.
//
// NOTE: This cache is module-level and shared across ALL Scraper instances in the process.
// If multiple Scraper instances use different fetch functions or auth contexts, they will
// still share the same cached document. This is acceptable because the document content
// (JS bundle hashes for transaction ID generation) is the same regardless of auth state.
//
// WARNING: When using multiple Scraper instances with different proxies (e.g., different
// IP addresses or regions), the first instance's fetch function wins for the cache duration.
// Subsequent instances will reuse the cached document even if their proxy would return
// different content. If this is a problem, call clearDocumentCache() between switching
// scraper instances to force a fresh fetch with the new proxy's fetch function.
let cachedDocumentPromise: Promise<Document> | null = null;
let cachedDocumentTimestamp = 0;
const DOCUMENT_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Clear the cached x.com document. Useful for testing or when the cached
 * document may be stale (e.g., after a long-running process).
 */
export function clearDocumentCache(): void {
  cachedDocumentPromise = null;
  cachedDocumentTimestamp = 0;
}

/**
 * Returns a cached x.com Document, fetching a fresh one if stale.
 *
 * **Note:** Only the first caller's `fetchFn` is captured (first-caller-wins).
 * Subsequent callers within the cache TTL share the same cached document
 * regardless of which `fetchFn` they pass. This is acceptable because all
 * callers in practice share the same fetch configuration.
 */
async function getCachedDocument(fetchFn: typeof fetch): Promise<Document> {
  const now = Date.now();
  if (
    !cachedDocumentPromise ||
    now - cachedDocumentTimestamp > DOCUMENT_CACHE_TTL
  ) {
    log('Fetching fresh x.com document for transaction ID generation');
    cachedDocumentTimestamp = now;
    // Store the Promise immediately so concurrent calls share the same fetch
    cachedDocumentPromise = handleXMigration(fetchFn).catch((err) => {
      // On failure, clear the cache so the next call retries
      cachedDocumentPromise = null;
      throw err;
    });
  } else {
    log('Using cached x.com document for transaction ID generation');
  }
  return cachedDocumentPromise;
}

let ClientTransaction:
  | typeof import('x-client-transaction-id')['ClientTransaction']
  | null = null;
async function clientTransaction(): Promise<
  typeof import('x-client-transaction-id')['ClientTransaction']
> {
  if (!ClientTransaction) {
    const mod = await import('x-client-transaction-id');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ClientTransaction = mod.ClientTransaction as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return mod.ClientTransaction as any;
  }
  return ClientTransaction;
}

/**
 * Generate a client transaction ID for the given URL and HTTP method.
 *
 * Uses a module-level cached document (shared across all Scraper instances).
 * When using multiple scrapers with different proxies, call
 * {@link clearDocumentCache} between instances to avoid stale cache hits.
 */
export async function generateTransactionId(
  url: string,
  fetchFn: typeof fetch,
  method: 'GET' | 'POST',
) {
  const parsedUrl = new URL(url);
  const path = parsedUrl.pathname;

  log(`Generating transaction ID for ${method} ${path}`);

  const document = await getCachedDocument(fetchFn);
  const ClientTransactionClass = await clientTransaction();
  const transaction = await ClientTransactionClass.create(document);
  const transactionId = await transaction.generateTransactionId(method, path);
  log(`Transaction ID: ${transactionId}`);

  return transactionId;
}
