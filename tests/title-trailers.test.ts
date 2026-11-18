import assert from "node:assert/strict";
import test from "node:test";
import { titleTrailerSources } from "../src/lib/title-trailers.ts";
import { malPromosFromResponse } from "../src/lib/mal-trailers.ts";

test("title trailers keep listing order, the first catalog and the first name", () => {
  const sources = titleTrailerSources([
    { via: "TMDB", videos: [{ id: "aaaaaaaaaaa" }, { id: "bbbbbbbbbbb", name: "Teaser" }] },
    { via: "Cinemeta", videos: [{ id: "aaaaaaaaaaa", name: "Official Trailer" }] },
    { via: "MyAnimeList", videos: [{ id: "ccccccccccc", name: " PV 1 " }, { id: "short" }] },
    { videos: [{ id: undefined }, { id: "  " }] },
  ]);
  assert.deepEqual(sources, [
    {
      key: "youtube:aaaaaaaaaaa",
      kind: "youtube",
      name: "Official Trailer",
      id: "aaaaaaaaaaa",
      via: "TMDB",
    },
    { key: "youtube:bbbbbbbbbbb", kind: "youtube", name: "Teaser", id: "bbbbbbbbbbb", via: "TMDB" },
    {
      key: "youtube:ccccccccccc",
      kind: "youtube",
      name: "PV 1",
      id: "ccccccccccc",
      via: "MyAnimeList",
    },
  ]);
});

test("MyAnimeList promos read the id from the embed URL when it is missing", () => {
  assert.deepEqual(
    malPromosFromResponse({
      promo: [
        { title: "PV", trailer: { youtube_id: "aaaaaaaaaaa" } },
        {
          title: "CM",
          trailer: {
            youtube_id: null,
            embed_url: "https://www.youtube-nocookie.com/embed/bbbbbbbbbbb?enablejsapi=1",
          },
        },
        { title: "Gone", trailer: { youtube_id: null, embed_url: null } },
      ],
    }),
    [
      { id: "aaaaaaaaaaa", name: "PV" },
      { id: "bbbbbbbbbbb", name: "CM" },
    ],
  );
  assert.deepEqual(malPromosFromResponse(null), []);
});
