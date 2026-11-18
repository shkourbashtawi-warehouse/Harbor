import assert from "node:assert/strict";
import test from "node:test";
import {
  activeTrailerSource,
  heroTrailerSources,
  nearestTrailerHeight,
  parseStoredTrailerQuality,
  trailerQualityFromPreference,
} from "../src/lib/games/hero-trailer.ts";

const trailers = [
  { name: "Launch", poster: "p1", url: "https://video.example/a.m3u8" },
  { name: "Duplicate", poster: "p2", url: "https://video.example/a.m3u8" },
  { name: "Empty", poster: "", url: "" },
];
const videos = [
  { id: "dQw4w9WgXcQ", title: "Reveal" },
  { id: "not-an-id", title: "Broken" },
];

test("hero trailer sources fall back from Steam to YouTube to the Steam clip", () => {
  const sources = heroTrailerSources({ trailers, videos, steamId: 601430, youtube: true });
  assert.deepEqual(
    sources.map((source) => source.key),
    ["steam:https://video.example/a.m3u8", "youtube:dQw4w9WgXcQ", "clip:601430"],
  );
});

test("hero trailer sources skip YouTube without the native resolver", () => {
  const sources = heroTrailerSources({ trailers: [], videos, youtube: false });
  assert.deepEqual(sources, []);
});

test("hero trailer keeps the chosen source by key and skips failed ones", () => {
  const sources = heroTrailerSources({ trailers, videos, steamId: 601430, youtube: true });
  assert.equal(activeTrailerSource(sources, null, new Set())?.kind, "steam");
  assert.equal(activeTrailerSource(sources, "youtube:dQw4w9WgXcQ", new Set())?.kind, "youtube");
  const reordered = [sources[2], sources[1], sources[0]];
  assert.equal(activeTrailerSource(reordered, "youtube:dQw4w9WgXcQ", new Set())?.kind, "youtube");
  assert.equal(
    activeTrailerSource(sources, "youtube:dQw4w9WgXcQ", new Set(["youtube:dQw4w9WgXcQ"]))?.kind,
    "steam",
  );
  assert.equal(activeTrailerSource(sources, null, new Set(sources.map((s) => s.key))), undefined);
});

test("hero trailer finds the exact chosen YouTube source after reordering", () => {
  const two = heroTrailerSources({
    trailers: [],
    videos: [
      { id: "dQw4w9WgXcQ", title: "Reveal" },
      { id: "9bZkp7q19f0", title: "Gameplay" },
    ],
    youtube: true,
  });
  const reordered = [two[1], two[0]];
  assert.equal(
    activeTrailerSource(reordered, "youtube:dQw4w9WgXcQ", new Set())?.key,
    "youtube:dQw4w9WgXcQ",
  );
  assert.equal(
    activeTrailerSource(reordered, "youtube:dQw4w9WgXcQ", new Set(["youtube:dQw4w9WgXcQ"]))?.key,
    "youtube:9bZkp7q19f0",
  );
});

test("hero trailer quality picks the nearest offered rendition", () => {
  assert.equal(nearestTrailerHeight([360, 1080, 720, 480], 720), 720);
  assert.equal(nearestTrailerHeight([360, 1080, 720], 480), 360);
  assert.equal(nearestTrailerHeight([720, 1080], 240), 720);
  assert.equal(nearestTrailerHeight([720, 1080], Number.MAX_SAFE_INTEGER), 1080);
  assert.equal(nearestTrailerHeight([720, 1080], "auto"), undefined);
  assert.equal(nearestTrailerHeight([], 720), undefined);
});

test("hero trailer quality reads the app preference and stored choice", () => {
  assert.equal(trailerQualityFromPreference("auto"), "auto");
  assert.equal(trailerQualityFromPreference("1080p"), 1080);
  assert.equal(trailerQualityFromPreference("best"), Number.MAX_SAFE_INTEGER);
  assert.equal(parseStoredTrailerQuality("auto"), "auto");
  assert.equal(parseStoredTrailerQuality("720"), 720);
  assert.equal(parseStoredTrailerQuality("-1"), undefined);
  assert.equal(parseStoredTrailerQuality(null), undefined);
});

test("ambient light treats a big frame change as a cut and small motion as easing", async () => {
  const { frameDifference, isSceneCut } = await import("../src/lib/games/ambient-light.ts");
  const frame = (r: number, g: number, b: number) =>
    new Uint8ClampedArray([r, g, b, 255, r, g, b, 255]);
  assert.equal(frameDifference(frame(10, 10, 10), frame(10, 10, 10)), 0);
  assert.equal(frameDifference(frame(0, 0, 0), frame(30, 0, 0)), 10);
  assert.equal(isSceneCut(null, frame(200, 0, 0)), false);
  assert.equal(isSceneCut(frame(20, 20, 20), frame(30, 25, 22)), false);
  assert.equal(isSceneCut(frame(20, 20, 20), frame(220, 30, 30)), true);
});

test("trailer providers group by catalog in first-appearance order", async () => {
  const { trailerProvider, trailerProviders } = await import("../src/lib/games/hero-trailer.ts");
  const sources = [
    { key: "steam:a", kind: "steam" as const, name: "A", url: "a", poster: "" },
    { key: "youtube:1", kind: "youtube" as const, name: "B", id: "aaaaaaaaaaa", via: "TMDB" },
    { key: "youtube:2", kind: "youtube" as const, name: "C", id: "bbbbbbbbbbb" },
    { key: "youtube:3", kind: "youtube" as const, name: "D", id: "ccccccccccc", via: "TMDB" },
    { key: "clip:1", kind: "clip" as const, name: "", appId: 1 },
  ];
  assert.equal(trailerProvider(sources[1]), "TMDB");
  assert.equal(trailerProvider(sources[2]), "YouTube");
  assert.deepEqual(trailerProviders(sources), [
    { name: "Steam", count: 2 },
    { name: "TMDB", count: 2 },
    { name: "YouTube", count: 1 },
  ]);
});

test("trailer filter splits by catalog first, then by season", async () => {
  const { trailerFacets, trailerFacetKey, trailerSeason } =
    await import("../src/lib/games/hero-trailer.ts");
  const video = (n: number, name: string, via?: string) => ({
    key: `youtube:${n}`,
    kind: "youtube" as const,
    name,
    id: String(n).padStart(11, "x"),
    via,
  });
  const series = [
    video(1, "Season 2 - Official Trailer", "TMDB"),
    video(2, "Season 1 - Teaser", "TMDB"),
    video(3, "Season 2 - Featurette", "TMDB"),
    video(4, "Behind the scenes", "TMDB"),
  ];
  assert.deepEqual(trailerSeason("Season 12 - Final Trailer"), {
    season: 12,
    title: "Final Trailer",
  });
  assert.deepEqual(trailerSeason("Official Trailer"), { title: "Official Trailer" });
  assert.deepEqual(trailerFacets(series), {
    by: "season",
    groups: [
      { key: "season:1", season: 1, count: 1 },
      { key: "season:2", season: 2, count: 2 },
    ],
  });
  assert.equal(trailerFacetKey(series[3], "season"), "");
  assert.equal(trailerFacets([...series, video(5, "Trailer", "MyAnimeList")])?.by, "provider");
  assert.equal(trailerFacets([video(1, "A", "TMDB"), video(2, "B", "TMDB")]), null);
});
