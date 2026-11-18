import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { ExternalLink, Play as PlayLine, RotateCcw, SkipForward, X } from "lucide-react";
import { ModalShell, useModalExit } from "@/components/modal-shell";
import { NavChevron } from "@/components/nav-arrow";
import { useRailScroll } from "@/hooks/use-rail-scroll";
import { useT } from "@/lib/i18n";
import { useSettings } from "@/lib/settings";
import { openUrl } from "@/lib/window";
import { forgetGameMicrotrailer, loadGameMicrotrailer } from "@/lib/games/catalog";
import {
  YOUTUBE_TRAILER_HEIGHTS,
  activeTrailerSource,
  nearestTrailerHeight,
  parseStoredTrailerQuality,
  trailerFacetKey,
  trailerFacets,
  trailerSeason,
  trailerQualityFromPreference,
  type HeroTrailerQuality,
  type HeroTrailerSource,
} from "@/lib/games/hero-trailer";
import {
  fetchTrailer,
  forgetTrailer,
  forgetTrailerVideo,
  resolveTrailerQuality,
  trailerSrc,
  type Quality,
} from "@/lib/trailer";
import { GameTrailer } from "./game-trailer";
import { GameHeroTrailerMenu } from "./game-hero-trailer-menu";
import { GameTrailerAmbient } from "./game-trailer-ambient";
import "./game-trailer-theater.css";

const QUALITY_KEY = "harbor.games.hero-trailer-quality.v1";
const AMBIENT_KEY = "harbor.games.trailer-ambient.v1";
// Steam's short clip is a plain HTTP lookup; a slow one is not worth waiting on.
const CLIP_TIMEOUT_MS = 30_000;
// After this long a YouTube trailer is reported as slow. It is never skipped for being slow:
// the native resolver finishes in the background and caches the stream, so giving up early
// only made a trailer that was about to play look broken.
const SLOW_SOURCE_MS = 12_000;
// One fresh attempt before a source that failed during playback is skipped.
const PLAYBACK_RETRIES = 1;

function storedQuality() {
  try {
    return parseStoredTrailerQuality(localStorage.getItem(QUALITY_KEY));
  } catch {
    return undefined;
  }
}

function storedAmbient() {
  try {
    return localStorage.getItem(AMBIENT_KEY) !== "off";
  } catch {
    return true;
  }
}

function withTimeout<T>(request: Promise<T>, fallback: T): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(fallback), CLIP_TIMEOUT_MS);
    request.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function thumbnail(source: HeroTrailerSource, art: string) {
  if (source.kind === "steam") return source.poster || art;
  if (source.kind === "youtube") return `https://i.ytimg.com/vi/${source.id}/mqdefault.jpg`;
  return art;
}

/** A focused viewing layer over the game page: player, details and the trailer queue. */
export function GameTrailerTheater({
  title,
  art,
  sources,
  active,
  onClose,
}: {
  /** The game, movie, series or anime the trailers belong to. */
  title: string;
  art: string;
  sources: HeroTrailerSource[];
  active: boolean;
  onClose: () => void;
}) {
  const t = useT(),
    { settings } = useSettings(),
    titleId = useId();
  const { closing, close } = useModalExit(onClose);
  const [chosen, setChosen] = useState<string | null>(null),
    [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set()),
    [choice, setChoice] = useState<HeroTrailerQuality>(
      () => storedQuality() ?? trailerQualityFromPreference(settings.trailerQuality),
    ),
    [levels, setLevels] = useState<{ key: string; heights: number[] } | null>(null),
    [resolved, setResolved] = useState<{ key: string; url: string; duration: number } | null>(null),
    [rate, setRate] = useState(1),
    [filter, setFilter] = useState<string | null>(null),
    [indicator, setIndicator] = useState<{ x: number; width: number } | null>(null),
    [ambient, setAmbient] = useState(storedAmbient),
    [videoElement, setVideoElement] = useState<HTMLVideoElement | null>(null),
    // Manual revivals per source, and playback retries per request since the last revival.
    [revivals, setRevivals] = useState<Readonly<Record<string, number>>>({}),
    [retries, setRetries] = useState<Readonly<Record<string, number>>>({}),
    [slowKey, setSlowKey] = useState<string | null>(null),
    [mutedChoice, setMutedChoice] = useState(false);
  const stage = useRef<HTMLDivElement>(null),
    queue = useRef<HTMLDivElement>(null),
    rail = useRailScroll(),
    focused = useRef(false),
    placed = useRef<HTMLElement | null>(null);
  const filters = useRef<HTMLDivElement>(null);
  const bindRail = rail.ref;
  // A stable callback ref: an inline one would detach and reattach the rail on every render.
  const queueRef = useCallback(
    (element: HTMLDivElement | null) => {
      queue.current = element;
      bindRail(element);
    },
    [bindRail],
  );
  const source = activeTrailerSource(sources, chosen, failed);
  const offered =
    source?.kind === "steam"
      ? levels?.key === source.key
        ? levels.heights
        : []
      : source?.kind === "youtube"
        ? [...YOUTUBE_TRAILER_HEIGHTS]
        : [];
  const height = nearestTrailerHeight(offered, choice);
  // "Best" (no cap) only ever comes from the app setting; the menu offers real heights.
  const youtubeQuality: Quality | undefined =
    source?.kind === "youtube"
      ? choice === Number.MAX_SAFE_INTEGER
        ? "best"
        : height
          ? (`${height}p` as Quality)
          : resolveTrailerQuality(settings.trailerQuality)
      : undefined;
  const requestKey = source ? `${source.key}@${youtubeQuality ?? ""}` : "";
  // A manual revival restarts the whole source; a playback retry is spent per quality, so a
  // newly picked YouTube rendition gets its own.
  const revival = source ? (revivals[source.key] ?? 0) : 0,
    retry = retries[`${requestKey}~${revival}`] ?? 0;
  // Changes on every retry, so the request and the player both start over.
  const loadKey = `${requestKey}#${revival}.${retry}`;
  const sourceKey = source?.key;
  const markFailed = (key: string) => setFailed((previous) => new Set(previous).add(key));
  const skip = () => {
    if (sourceKey) markFailed(sourceKey);
  };

  useEffect(() => {
    if (!source || source.kind === "steam") return;
    let current = true;
    // A failure belongs to the trailer that was asked for, never to whatever is selected
    // by the time it arrives.
    const fail = () => {
      if (current) markFailed(source.key);
    };
    // A YouTube trailer is only skipped when the resolver reports failure, never for time.
    const request =
      source.kind === "youtube"
        ? fetchTrailer(source.id, youtubeQuality).then((info) => ({
            url: info ? trailerSrc(info) : "",
            duration: info?.duration_seconds ?? 0,
          }))
        : withTimeout(
            loadGameMicrotrailer(source.appId).then((url) => ({ url, duration: 0 })),
            { url: "", duration: 0 },
          );
    const slow = setTimeout(() => {
      if (current) setSlowKey(loadKey);
    }, SLOW_SOURCE_MS);
    request
      .then(({ url, duration }) => {
        if (!current) return;
        if (url) setResolved({ key: loadKey, url, duration });
        else fail();
      }, fail)
      .finally(() => clearTimeout(slow));
    return () => {
      current = false;
      clearTimeout(slow);
    };
    // loadKey covers the source, the requested YouTube rendition and the retry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadKey]);

  const facets = trailerFacets(sources);
  // A choice that no longer names a group (the list changed under it) falls back to All,
  // so the list and the highlighted button always agree.
  const activeFilter =
    facets && filter && facets.groups.some((group) => group.key === filter) ? filter : null;
  const facetLayout = facets
    ? facets.groups.map((group) => `${group.key}:${group.count}`).join()
    : "";
  // The selected filter's pill slides under it rather than jumping; labels and counts can
  // change its width, so they re-measure too.
  useLayoutEffect(() => {
    const group = filters.current;
    const active = group?.querySelector<HTMLElement>("[aria-pressed=true]");
    setIndicator(active ? { x: active.offsetLeft, width: active.offsetWidth } : null);
  }, [activeFilter, facetLayout, sources.length]);
  const resetRail = rail.reset;
  useEffect(() => {
    resetRail();
    // Only a filter change resets the strip; the reset function changes every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFilter]);
  const url = source?.kind === "steam" ? source.url : resolved?.key === loadKey ? resolved.url : "";
  const slow = slowKey === loadKey && !url;
  // A playback error can be a stale stream or a passing network fault: resolve the same
  // trailer once more before moving on.
  const playbackFailed = () => {
    if (!source) return;
    if (retry >= PLAYBACK_RETRIES) {
      skip();
      return;
    }
    if (source.kind === "youtube" && youtubeQuality) forgetTrailer(source.id, youtubeQuality);
    if (source.kind === "clip") forgetGameMicrotrailer(source.appId);
    const key = `${requestKey}~${revival}`;
    // hls.js and the video element can both report one failure; count it once.
    setRetries((previous) =>
      (previous[key] ?? 0) === retry ? { ...previous, [key]: retry + 1 } : previous,
    );
  };
  // Gives failed sources a clean start: no cached failure, a new load identity and a full
  // retry budget. A slow source the viewer skipped never failed, so its request carries on.
  const revive = (items: HeroTrailerSource[]) => {
    const dead = items.filter((item) => failed.has(item.key));
    if (!dead.length) return;
    for (const item of dead) {
      if (item.kind === "youtube") forgetTrailerVideo(item.id);
      if (item.kind === "clip") forgetGameMicrotrailer(item.appId);
    }
    setRevivals((previous) => {
      const next = { ...previous };
      for (const item of dead) next[item.key] = (previous[item.key] ?? 0) + 1;
      return next;
    });
    setFailed((previous) => {
      const next = new Set(previous);
      for (const item of dead) next.delete(item.key);
      return next;
    });
  };
  useEffect(() => {
    const node = stage.current;
    const dialog = node?.closest("[role=dialog]");
    if (!node || !dialog) return;
    // After the first landing, only step in when a replaced player took focus with it;
    // focus on a queue card or another control stays where the viewer put it.
    const held = document.activeElement;
    const own = held === placed.current;
    if (focused.current && !own && held && held !== document.body && dialog.contains(held)) return;
    // Land on play/pause so shortcuts work at once and arrows still move between controls.
    const target =
      node.querySelector<HTMLElement>(".games-player-control-row button") ??
      dialog.querySelector<HTMLElement>(".games-theater-close");
    target?.focus({ preventScroll: true });
    // A stand-in chosen while loading gives way to play/pause once the trailer arrives.
    placed.current = url ? null : (target ?? null);
    if (url) focused.current = true;
  }, [url]);
  useEffect(() => {
    queue.current
      ?.querySelector<HTMLElement>("[aria-current=true]")
      ?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  }, [sourceKey]);

  // The browser leaves full screen on Escape before the key reaches the page,
  // so a dismissal right after that exit only meant "leave full screen".
  const fullscreenExit = useRef(0);
  useEffect(() => {
    const change = () => {
      if (!document.fullscreenElement) fullscreenExit.current = Date.now();
    };
    document.addEventListener("fullscreenchange", change);
    return () => document.removeEventListener("fullscreenchange", change);
  }, []);
  // One Escape reaches both the app's Back handling (which closes an open settings menu) and
  // this dialog's own listener, in that order and in the same dispatch. By then the menu is
  // gone, so its close time is what tells the two apart.
  const menuClosedAt = useRef(0);
  const dismiss = () => {
    if (stage.current?.querySelector(".games-hero-trailer-popover")) return;
    if (performance.now() - menuClosedAt.current < 100) return;
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else if (Date.now() - fullscreenExit.current > 400) close();
  };
  const pick = (value: HeroTrailerQuality) => {
    setChoice(value);
    try {
      localStorage.setItem(QUALITY_KEY, String(value));
    } catch {
      /* The choice still applies for this session. */
    }
  };
  const toggleAmbient = (on: boolean) => {
    setAmbient(on);
    try {
      localStorage.setItem(AMBIENT_KEY, on ? "on" : "off");
    } catch {
      /* The choice still applies for this session. */
    }
  };
  const choose = (item: HeroTrailerSource) => {
    setChosen(item.key);
    // A manual pick deserves a fresh attempt even if it failed earlier.
    revive([item]);
  };
  const sourceName = (item: HeroTrailerSource) =>
    item.kind === "clip"
      ? t("games.player.clip")
      : trailerSeason(item.name).title || t("games.trailer");
  // The season moves from the start of the name to the caption, beside the catalog.
  const caption = (item: HeroTrailerSource) => {
    const { season } = trailerSeason(item.name);
    const from = provider(item);
    return season === undefined ? from : `${t("Season {n}", { n: season })} · ${from}`;
  };
  const provider = (item: HeroTrailerSource) =>
    item.kind !== "youtube" ? "Steam" : item.via ? `${item.via} · YouTube` : "YouTube";
  const qualityChoices: HeroTrailerQuality[] = [
    "auto",
    ...[...new Set(offered)].sort((a, b) => b - a),
  ];
  const shown =
    facets && activeFilter
      ? sources.filter((item) => trailerFacetKey(item, facets.by) === activeFilter)
      : sources;
  // "Next" follows the list the viewer is looking at; outside it, the full order.
  const order = source && shown.includes(source) ? shown : sources;
  const after = source ? order.slice(order.indexOf(source) + 1) : [];
  const upNext = after.find((item) => !failed.has(item.key));
  // When nothing plays here, YouTube itself may still: offer the viewer's pick, else the first.
  const youtube = sources.filter((item) => item.kind === "youtube");
  const external = youtube.find((item) => item.key === chosen) ?? youtube[0];

  return (
    <ModalShell
      closing={closing}
      onDismiss={dismiss}
      width={1320}
      labelledBy={titleId}
      backdropClassName={`games-theater-backdrop${closing ? " is-closing" : ""}`}
    >
      <div className="games-theater" data-tv-focus-scope>
        {ambient && url ? (
          <GameTrailerAmbient video={videoElement} />
        ) : (
          <div
            className="games-theater-ambient"
            style={{ backgroundImage: `url("${art.replace(/"/g, "%22")}")` }}
            aria-hidden="true"
          />
        )}
        <header className="games-theater-head">
          <div className="games-theater-heading">
            <span className="games-theater-eyebrow">
              <PlayLine size={11} strokeWidth={2.25} />
              {t("games.trailer")}
            </span>
            <h2 id={titleId}>{title}</h2>
            {source && (
              <p>
                {sourceName(source)}
                <span aria-hidden="true">·</span>
                {caption(source)}
              </p>
            )}
          </div>
          <button
            type="button"
            className="games-theater-close"
            data-tv-modal-close
            onClick={dismiss}
          >
            <span className="games-theater-close-icon">
              <X size={16} strokeWidth={1.75} />
            </span>
            {t("games.player.closeTrailer")}
            <kbd>Esc</kbd>
          </button>
        </header>
        <div className="games-theater-shell">
          <div ref={stage} className="games-theater-core">
            {source && url ? (
              <GameTrailer
                key={loadKey}
                url={url}
                poster={source.kind === "steam" ? source.poster || art : art}
                active={active && !closing}
                intentional
                pinned
                cinema
                // The viewer's own mute survives quality changes, retries and Next.
                startMuted={mutedChoice}
                onMutedChoice={setMutedChoice}
                rate={rate}
                knownDuration={source.kind === "youtube" ? resolved?.duration : undefined}
                quality={source.kind === "steam" ? height : undefined}
                onQualities={(heights) => setLevels({ key: source.key, heights })}
                onError={playbackFailed}
                onNext={upNext ? () => choose(upNext) : undefined}
                onVideo={setVideoElement}
                controls={
                  <GameHeroTrailerMenu
                    qualities={qualityChoices}
                    choice={choice}
                    height={height}
                    onQuality={pick}
                    rate={rate}
                    onRate={setRate}
                    ambient={ambient}
                    onAmbient={toggleAmbient}
                    onClose={() => {
                      menuClosedAt.current = performance.now();
                    }}
                  />
                }
              />
            ) : (
              <div className="games-theater-wait">
                <img src={source ? thumbnail(source, art) : art} alt="" />
                <div className="games-theater-status" role={source ? "status" : "alert"}>
                  {source ? (
                    <>
                      <div className="games-player-buffering" aria-hidden="true">
                        <i />
                        <i />
                        <i />
                      </div>
                      <p>{t("games.player.loadingNamed", { name: sourceName(source) })}</p>
                      {slow && <small>{t("games.player.slowSource")}</small>}
                      {upNext && (
                        <button
                          type="button"
                          className="games-theater-pill"
                          // Moving on is the viewer's choice, not a failure: the slow trailer
                          // keeps resolving and plays at once if they come back to it.
                          onClick={() => choose(upNext)}
                        >
                          <SkipForward size={15} strokeWidth={1.75} />
                          {t("games.player.nextSource")}
                        </button>
                      )}
                    </>
                  ) : (
                    <>
                      <p>{t("games.player.noTrailer")}</p>
                      {sources.length > 0 && (
                        <button
                          type="button"
                          className="games-theater-pill"
                          onClick={() => {
                            setChosen(null);
                            revive(sources);
                          }}
                        >
                          <RotateCcw size={15} strokeWidth={1.75} />
                          {t("games.player.retry")}
                        </button>
                      )}
                      {external && (
                        <button
                          type="button"
                          className="games-theater-pill"
                          onClick={() => openUrl(`https://www.youtube.com/watch?v=${external.id}`)}
                        >
                          <ExternalLink size={15} strokeWidth={1.75} />
                          {t("Watch on YouTube")}
                        </button>
                      )}
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
        {sources.length > 1 && (
          <section className="games-theater-queue" aria-label={t("games.player.allTrailers")}>
            <div className="games-theater-queue-head">
              <h3>
                {t("games.player.allTrailers")}
                <span>{shown.length}</span>
              </h3>
              {facets && (
                <div className="games-theater-filter-shell">
                  <div
                    ref={filters}
                    className="games-theater-filter"
                    role="group"
                    aria-label={t("games.player.filterSources")}
                  >
                    {indicator && (
                      <span
                        className="games-theater-filter-pill"
                        aria-hidden="true"
                        style={{
                          width: indicator.width,
                          transform: `translateX(${indicator.x}px)`,
                        }}
                      />
                    )}
                    {[
                      { key: null, label: t("games.player.allSources"), count: sources.length },
                      ...facets.groups.map((group) => ({
                        key: group.key,
                        label: "season" in group ? t("Season {n}", { n: group.season }) : group.key,
                        count: group.count,
                      })),
                    ].map((item) => (
                      <button
                        key={item.key ?? "*"}
                        type="button"
                        aria-pressed={activeFilter === item.key}
                        onClick={() => setFilter(item.key)}
                      >
                        {item.label}
                        <span>{item.count}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
            <div
              className={`games-theater-rail${rail.edges.start ? " has-start" : ""}${rail.edges.end ? " has-end" : ""}`}
            >
              <button
                type="button"
                className="games-theater-rail-arrow is-start"
                aria-label={t("common.previous")}
                tabIndex={-1}
                hidden={!rail.edges.start}
                onClick={() => rail.page(-1)}
              >
                <NavChevron dir="left" size={16} />
              </button>
              <div ref={queueRef} className="games-theater-cards">
                {shown.map((item, index) => {
                  const current = item.key === source?.key;
                  return (
                    <button
                      key={item.key}
                      type="button"
                      className={`games-theater-card${failed.has(item.key) ? " is-failed" : ""}`}
                      aria-current={current}
                      style={{ animationDelay: `${Math.min(index, 8) * 40}ms` }}
                      onClick={() => choose(item)}
                    >
                      <span className="games-theater-thumb">
                        <img src={thumbnail(item, art)} alt="" loading="lazy" draggable={false} />
                        {current && (
                          <span className="games-theater-now">
                            <i />
                            <i />
                            <i />
                          </span>
                        )}
                      </span>
                      <span className="games-theater-card-text">
                        <strong>{sourceName(item)}</strong>
                        <small>{caption(item)}</small>
                      </span>
                    </button>
                  );
                })}
              </div>
              <button
                type="button"
                className="games-theater-rail-arrow is-end"
                aria-label={t("common.next")}
                tabIndex={-1}
                hidden={!rail.edges.end}
                onClick={() => rail.page(1)}
              >
                <NavChevron dir="right" size={16} />
              </button>
            </div>
          </section>
        )}
      </div>
    </ModalShell>
  );
}
