import { useEffect, useState } from "react";
import { addonOnlyMetadata } from "@/lib/metadata-policy";
import { resolveMalId } from "@/lib/mal-rating";
import { animeCatalogRequest } from "@/lib/providers/anime-catalog-client";

export type MalPromo = { id: string; name: string };

type PromoResponse = {
  promo?: Array<{
    title?: string;
    trailer?: { youtube_id?: string | null; embed_url?: string | null };
  }>;
};

const EMBED_ID = /\/embed\/([\w-]{11})/;
const CACHE_MAX = 50;
const NO_PROMOS: MalPromo[] = [];
const cache = new Map<number, Promise<MalPromo[]>>();

/** MyAnimeList lists most promos with only an embed URL, so the id is read from it too. */
export function malPromosFromResponse(data: PromoResponse | null | undefined): MalPromo[] {
  const promos: MalPromo[] = [];
  for (const item of data?.promo ?? []) {
    const id = item.trailer?.youtube_id || item.trailer?.embed_url?.match(EMBED_ID)?.[1];
    if (id) promos.push({ id, name: item.title?.trim() ?? "" });
  }
  return promos;
}

export function malPromoVideos(malId: number): Promise<MalPromo[]> {
  const hit = cache.get(malId);
  if (hit) return hit;
  const request = animeCatalogRequest<PromoResponse>(`/anime/${malId}/videos`)
    .then((response) => malPromosFromResponse(response.data))
    .catch(() => {
      cache.delete(malId);
      return [];
    });
  cache.set(malId, request);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  return request;
}

/** Promo videos MyAnimeList lists for an anime, fetched only once `enabled` is set. */
export function useMalTrailers(metaId: string | undefined, enabled: boolean): MalPromo[] {
  const [promos, setPromos] = useState<{ id: string; list: MalPromo[] } | null>(null);
  useEffect(() => {
    if (!metaId || !enabled || addonOnlyMetadata()) return;
    let cancelled = false;
    void resolveMalId(metaId)
      .then((malId) => (malId ? malPromoVideos(malId) : []))
      .then((list) => {
        if (!cancelled) setPromos({ id: metaId, list });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [metaId, enabled]);
  return promos && promos.id === metaId ? promos.list : NO_PROMOS;
}
