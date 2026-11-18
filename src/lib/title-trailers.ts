import { isYoutubeId, type HeroTrailerSource } from "@/lib/games/hero-trailer";

export type YoutubeTrailerSource = Extract<HeroTrailerSource, { kind: "youtube" }>;

export type TrailerListing = {
  /** Catalog that listed these videos, such as TMDB, Cinemeta or MyAnimeList. */
  via?: string;
  videos: readonly { id: string | undefined; name?: string }[];
};

/**
 * Theater sources for a movie, series or anime. Listings arrive in priority order;
 * a video listed twice keeps its first position and catalog, and takes the first
 * name any listing gives it.
 */
export function titleTrailerSources(listings: readonly TrailerListing[]): YoutubeTrailerSource[] {
  const sources: YoutubeTrailerSource[] = [];
  const byId = new Map<string, YoutubeTrailerSource>();
  for (const listing of listings) {
    for (const video of listing.videos) {
      const id = video.id?.trim();
      if (!id || !isYoutubeId(id)) continue;
      const name = video.name?.trim() ?? "";
      const known = byId.get(id);
      if (known) {
        if (!known.name && name) known.name = name;
        continue;
      }
      const source: YoutubeTrailerSource = { key: `youtube:${id}`, kind: "youtube", name, id };
      if (listing.via) source.via = listing.via;
      byId.set(id, source);
      sources.push(source);
    }
  }
  return sources;
}
