import type { TrailerQualityPref } from "@/lib/trailer";

export type HeroTrailerSource =
  | { key: string; kind: "steam"; name: string; url: string; poster: string }
  /** `via` names the catalog that listed the video, such as TMDB or MyAnimeList. */
  | { key: string; kind: "youtube"; name: string; id: string; via?: string }
  | { key: string; kind: "clip"; name: string; appId: number };

/** A rendition height, or adaptive selection. */
export type HeroTrailerQuality = "auto" | number;

/** Heights the native YouTube resolver can be asked for. */
export const YOUTUBE_TRAILER_HEIGHTS = [1080, 720, 360] as const;

const YOUTUBE_ID = /^[\w-]{11}$/;

export function isYoutubeId(value: string): boolean {
  return YOUTUBE_ID.test(value);
}

/**
 * Playback order for the hero trailer. Steam's own HLS trailers come first
 * because they start instantly and offer every rendition; IGDB's YouTube
 * trailers need the native resolver; Steam's short silent clip is last.
 */
export function heroTrailerSources({
  trailers,
  videos,
  steamId,
  youtube,
}: {
  trailers: readonly { name: string; poster: string; url: string }[];
  videos: readonly { id: string; title: string }[];
  steamId?: number;
  youtube: boolean;
}): HeroTrailerSource[] {
  const sources: HeroTrailerSource[] = [];
  const seen = new Set<string>();
  const add = (source: HeroTrailerSource) => {
    if (seen.has(source.key)) return;
    seen.add(source.key);
    sources.push(source);
  };
  for (const trailer of trailers)
    if (trailer.url)
      add({
        key: `steam:${trailer.url}`,
        kind: "steam",
        name: trailer.name,
        url: trailer.url,
        poster: trailer.poster,
      });
  if (youtube)
    for (const video of videos)
      if (YOUTUBE_ID.test(video.id))
        add({ key: `youtube:${video.id}`, kind: "youtube", name: video.title, id: video.id });
  if (steamId && Number.isSafeInteger(steamId) && steamId > 0)
    add({ key: `clip:${steamId}`, kind: "clip", name: "", appId: steamId });
  return sources;
}

/**
 * The source to play: the chosen one while it works, else the first that has
 * not failed. Keys keep the choice stable when late metadata reorders the list.
 */
export function activeTrailerSource(
  sources: readonly HeroTrailerSource[],
  chosen: string | null,
  failed: ReadonlySet<string>,
): HeroTrailerSource | undefined {
  const picked = chosen ? sources.find((source) => source.key === chosen) : undefined;
  if (picked && !failed.has(picked.key)) return picked;
  return sources.find((source) => !failed.has(source.key));
}

/** The highest offered height not above the wanted one, else the lowest offered. */
export function nearestTrailerHeight(
  offered: readonly number[],
  wanted: HeroTrailerQuality,
): number | undefined {
  if (wanted === "auto" || !offered.length) return undefined;
  const sorted = [...new Set(offered)].sort((a, b) => b - a);
  return sorted.find((height) => height <= wanted) ?? sorted[sorted.length - 1];
}

/** The app-wide trailer quality preference expressed as a hero choice. */
export function trailerQualityFromPreference(pref: TrailerQualityPref): HeroTrailerQuality {
  if (pref === "auto") return "auto";
  if (pref === "best") return Number.MAX_SAFE_INTEGER;
  return Number.parseInt(pref, 10);
}

export function parseStoredTrailerQuality(value: string | null): HeroTrailerQuality | undefined {
  if (value === "auto") return "auto";
  const height = Number(value);
  return value !== null && Number.isSafeInteger(height) && height > 0 ? height : undefined;
}

/** The catalog a trailer is filed under in the theater's filter: Steam, or who listed the video. */
export function trailerProvider(source: HeroTrailerSource): string {
  if (source.kind !== "youtube") return "Steam";
  return source.via?.trim() || "YouTube";
}

/** Providers in first-appearance order, with how many trailers each lists. */
export function trailerProviders(
  sources: readonly HeroTrailerSource[],
): { name: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const source of sources) {
    const name = trailerProvider(source);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts].map(([name, count]) => ({ name, count }));
}

// TMDB names season videos "Season 3 - Official Trailer".
const SEASON_PREFIX = /^Season (\d+) - /;

/** A trailer's season and its name without the season prefix, when the catalog gave one. */
export function trailerSeason(name: string): { season?: number; title: string } {
  const match = SEASON_PREFIX.exec(name);
  if (!match) return { title: name };
  const season = Number(match[1]);
  return { season, title: name.slice(match[0].length).trim() || name };
}

export type TrailerFacets =
  | { by: "provider"; groups: { key: string; count: number }[] }
  | { by: "season"; groups: { key: string; season: number; count: number }[] };

/**
 * How the theater's filter splits a long list: by catalog when several list trailers,
 * otherwise by season when a series spans several. Null when one group would hold them all.
 */
export function trailerFacets(sources: readonly HeroTrailerSource[]): TrailerFacets | null {
  const providers = trailerProviders(sources);
  if (providers.length > 1)
    return { by: "provider", groups: providers.map(({ name, count }) => ({ key: name, count })) };
  const seasons = new Map<number, number>();
  for (const source of sources) {
    const { season } = trailerSeason(source.name);
    if (season !== undefined) seasons.set(season, (seasons.get(season) ?? 0) + 1);
  }
  if (seasons.size < 2) return null;
  return {
    by: "season",
    groups: [...seasons]
      .sort(([a], [b]) => a - b)
      .map(([season, count]) => ({ key: `season:${season}`, season, count })),
  };
}

/** The filter group a trailer belongs to under the given split. */
export function trailerFacetKey(source: HeroTrailerSource, by: TrailerFacets["by"]): string {
  if (by === "provider") return trailerProvider(source);
  const { season } = trailerSeason(source.name);
  return season === undefined ? "" : `season:${season}`;
}
