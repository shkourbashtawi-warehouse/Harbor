// Tenrai implements the Jikan v4 response schema for public MAL metadata.
// https://tenrai.org/docs — 120 requests/minute, 4/second without a server key.
export const ANIME_CATALOG_BASE = "https://api.tenrai.org/v1";
export const ANIME_CATALOG_FALLBACK = "https://jikanfortheweebs.midnightignite.me/v4";

// The whole embed segment, so a longer id is rejected rather than cut down to 11 characters.
const PROMO_EMBED_ID = /\/embed\/([\w-]{11})(?:[?#/&]|$)/;
const YOUTUBE_ID = /^[\w-]{11}$/;

/** The YouTube id of a MyAnimeList promo entry; most list only an embed URL. Field types are
 *  checked, so one malformed entry never throws. */
export function malPromoYoutubeId(entry: unknown): string | undefined {
  const trailer = (entry as { trailer?: unknown } | null)?.trailer as
    | { youtube_id?: unknown; embed_url?: unknown }
    | null
    | undefined;
  if (typeof trailer !== "object" || trailer === null) return undefined;
  const direct = typeof trailer.youtube_id === "string" ? trailer.youtube_id.trim() : "";
  if (YOUTUBE_ID.test(direct)) return direct;
  return typeof trailer.embed_url === "string"
    ? trailer.embed_url.match(PROMO_EMBED_ID)?.[1]
    : undefined;
}

export function catalogRetryDelay(value: string | null, now: number): number {
  const seconds = value === null ? NaN : Number(value);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value ?? "") - now;
  return Number.isFinite(delay) ? Math.max(550, delay) : 2000;
}

export function createAnimeCatalogClient(
  options: {
    fetch?: typeof fetch;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    fallbackFetch?: typeof fetch;
    intervalMs?: number;
    fallbackIntervalMs?: number;
    timeoutMs?: number;
    cooldownMs?: number;
  } = {},
) {
  const request = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const timeout = options.timeoutMs ?? 12000,
    cooldown = options.cooldownMs ?? 60000;
  const providers = [
    {
      base: ANIME_CATALOG_BASE,
      fetch: request,
      interval: options.intervalMs ?? 550,
      nextStart: 0,
      unavailableUntil: 0,
    },
    // Midnight's public cache-miss budget is 60/minute, lower than Tenrai's.
    {
      base: ANIME_CATALOG_FALLBACK,
      fetch: options.fallbackFetch ?? request,
      interval: options.fallbackIntervalMs ?? 1100,
      nextStart: 0,
      unavailableUntil: 0,
    },
  ];
  let queue = Promise.resolve();
  let lastError: unknown = new Error("Anime catalogs temporarily unavailable");
  const inflight = new Map<string, Promise<unknown>>();

  return function catalogRequest<T>(path: string): Promise<{ data: T }> {
    if (!/^\/(?:anime|top\/anime|seasons)(?:[/?]|$)/.test(path) || path.includes("..")) {
      return Promise.reject(new Error("Invalid anime catalog path"));
    }
    const existing = inflight.get(path);
    if (existing) return existing as Promise<{ data: T }>;
    const pending = queue.then(async () => {
      for (const provider of providers) {
        // One dead provider must not add another timeout to every queued row.
        if (provider.unavailableUntil > now()) continue;
        if (provider.nextStart > now()) await sleep(provider.nextStart - now());
        const controller = new AbortController();
        // Queue time never consumes the request's network timeout.
        const timer = setTimeout(() => controller.abort(), timeout);
        let retry = cooldown;
        try {
          const response = await provider.fetch(`${provider.base}${path}`, {
            signal: controller.signal,
            credentials: "omit",
            headers: { Accept: "application/json" },
          });
          if (response.status === 429) {
            retry = catalogRetryDelay(response.headers.get("retry-after"), now());
          }
          // A missing title or invalid query says nothing about provider health.
          if ([400, 404, 422].includes(response.status)) retry = 0;
          if (!response.ok) {
            throw new Error(`Anime catalog HTTP ${response.status}`);
          }
          // An anime's videos come back as one object of promo, episode and music lists. A
          // bad body for one title, unparseable JSON included, says nothing about the
          // provider's other endpoints.
          const videos = /^\/anime\/\d+\/videos(?:\?|$)/.test(path);
          if (videos) retry = 0;
          const payload: unknown = await response.json();
          if (
            !payload ||
            typeof payload !== "object" ||
            !("data" in payload) ||
            payload.data == null
          ) {
            throw new Error("Invalid anime catalog response");
          }
          const detail = /^\/anime\/\d+(?:\/full)?(?:\?|$)/.test(path);
          const data = payload.data as object;
          const promo = (data as { promo?: unknown }).promo;
          if (
            videos
              ? Array.isArray(data) ||
                typeof data !== "object" ||
                !Array.isArray(promo) ||
                // Entries present but none usable: let the other provider answer instead.
                (promo.length > 0 && !promo.some((entry) => !!malPromoYoutubeId(entry)))
              : detail
                ? Array.isArray(data) || typeof data !== "object" || !("mal_id" in data)
                : !Array.isArray(data)
          ) {
            throw new Error("Invalid anime catalog data");
          }
          provider.unavailableUntil = 0;
          return payload as { data: T };
        } catch (error) {
          lastError = error;
          provider.unavailableUntil = now() + retry;
        } finally {
          clearTimeout(timer);
          provider.nextStart = now() + provider.interval;
        }
      }
      throw lastError;
    });
    queue = pending.then(
      () => {},
      () => {},
    );
    const result = pending.finally(() => inflight.delete(path));
    inflight.set(path, result);
    return result;
  };
}

export const animeCatalogRequest = createAnimeCatalogClient({
  // Midnight doesn't send CORS headers. Native Harbor uses its HTTP bridge;
  // Harbor Web uses the explicitly allowed same-origin proxy.
  fallbackFetch: async (...args) => (await import("../safe-fetch")).safeFetch(...args),
});
