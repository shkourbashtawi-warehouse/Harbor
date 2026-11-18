import { useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Gauge,
  Settings,
  SlidersHorizontal,
  Sparkles,
} from "lucide-react";
import { useT } from "@/lib/i18n";
import { pushBackHandler } from "@/lib/back-intercept";
import type { HeroTrailerQuality } from "@/lib/games/hero-trailer";

export const TRAILER_RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as const;

type Panel = "main" | "quality" | "speed";

/** YouTube-style settings: a summary panel that opens one list at a time. */
export function GameHeroTrailerMenu({
  qualities,
  choice,
  height,
  onQuality,
  rate,
  onRate,
  ambient,
  onAmbient,
  onClose,
}: {
  qualities: HeroTrailerQuality[];
  choice: HeroTrailerQuality;
  height?: number;
  onQuality: (value: HeroTrailerQuality) => void;
  rate: number;
  onRate: (value: number) => void;
  ambient: boolean;
  onAmbient: (on: boolean) => void;
  /** Lets the owner tell a Back that closed this menu from one meant for itself. */
  onClose?: () => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false),
    [panel, setPanel] = useState<Panel>("main");
  const area = useRef<HTMLDivElement>(null),
    toggle = useRef<HTMLButtonElement>(null),
    popover = useRef<HTMLDivElement>(null);
  const close = () => {
    setOpen(false);
    onClose?.();
    toggle.current?.focus({ preventScroll: true });
  };
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!open) return;
    // Like the shared dropdown: an open menu takes Back first, so Back closes only the menu.
    const removeBack = pushBackHandler(() => {
      closeRef.current();
      return true;
    });
    const outside = (event: PointerEvent) => {
      if (!area.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => {
      removeBack();
      document.removeEventListener("pointerdown", outside);
    };
  }, [open]);
  useEffect(() => {
    if (open) popover.current?.querySelector<HTMLElement>("button:not([hidden])")?.focus();
  }, [open, panel]);

  const qualityLabel = (value: HeroTrailerQuality) =>
    value === "auto" ? t("games.player.qualityAuto") : `${value}p`;
  const rateLabel = (value: number) => (value === 1 ? t("games.player.speedNormal") : `${value}`);
  const rows: { id: Panel; icon: typeof Gauge; label: string; value: string; show: boolean }[] = [
    {
      id: "quality",
      icon: SlidersHorizontal,
      label: t("games.player.quality"),
      value:
        choice === "auto"
          ? height
            ? `${t("games.player.qualityAuto")} (${height}p)`
            : t("games.player.qualityAuto")
          : qualityLabel(height ?? choice),
      show: qualities.length > 1,
    },
    {
      id: "speed",
      icon: Gauge,
      label: t("games.player.speed"),
      value: rateLabel(rate),
      show: true,
    },
  ];
  const option = (selected: boolean, label: string, pick: () => void) => (
    <button key={label} type="button" role="menuitemradio" aria-checked={selected} onClick={pick}>
      <span className="games-trailer-menu-check">{selected && <Check size={16} />}</span>
      <span className="games-trailer-menu-label">{label}</span>
    </button>
  );
  const back = (label: string) => (
    <button type="button" className="games-trailer-menu-back" onClick={() => setPanel("main")}>
      <ChevronLeft size={18} />
      {label}
    </button>
  );

  return (
    <div ref={area} className={`games-hero-trailer-menu${open ? " is-open" : ""}`}>
      <span className="games-player-tip">
        <button
          ref={toggle}
          type="button"
          aria-label={t("games.player.settings")}
          aria-expanded={open}
          aria-haspopup="menu"
          onClick={() => {
            setPanel("main");
            setOpen((value) => !value);
          }}
        >
          <Settings size={20} strokeWidth={1.75} className="games-trailer-menu-gear" />
        </button>
        {!open && (
          <span className="games-player-tooltip" aria-hidden="true">
            {t("games.player.settings")}
          </span>
        )}
      </span>
      {open && (
        <div
          ref={popover}
          className="games-hero-trailer-popover"
          role="menu"
          aria-label={t("games.player.settings")}
          data-tv-focus-scope
          onKeyDown={(event) => {
            // role="menu" opts out of global spatial navigation, so the menu moves focus itself.
            const items = [
              ...(popover.current?.querySelectorAll<HTMLElement>("button:not([hidden])") ?? []),
            ];
            const at = items.indexOf(document.activeElement as HTMLElement);
            const rtl = getComputedStyle(event.currentTarget).direction === "rtl";
            const forward = rtl ? "ArrowLeft" : "ArrowRight",
              backward = rtl ? "ArrowRight" : "ArrowLeft";
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              const step = event.key === "ArrowDown" ? 1 : -1;
              items[(at + step + items.length) % items.length]?.focus();
            } else if (event.key === forward && panel === "main" && at >= 0) items[at].click();
            else if (event.key === backward && panel !== "main") setPanel("main");
            else if (event.key === "Home") items[0]?.focus();
            else if (event.key === "End") items[items.length - 1]?.focus();
            else return;
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          {/* Back/Escape on keyboards, remotes and gamepads closes the top focus scope through this. */}
          <button type="button" hidden data-tv-modal-close onClick={close} />
          {panel === "main" && (
            <button
              type="button"
              role="menuitemcheckbox"
              aria-checked={ambient}
              className="games-trailer-menu-row"
              onClick={() => onAmbient(!ambient)}
            >
              <Sparkles size={18} strokeWidth={1.75} />
              <span className="games-trailer-menu-label">{t("games.player.ambient")}</span>
              <span className="games-trailer-menu-switch" aria-hidden="true" />
            </button>
          )}
          {panel === "main" &&
            rows
              .filter((row) => row.show)
              .map((row) => (
                <button
                  key={row.id}
                  type="button"
                  role="menuitem"
                  className="games-trailer-menu-row"
                  onClick={() => setPanel(row.id)}
                >
                  <row.icon size={18} strokeWidth={1.75} />
                  <span className="games-trailer-menu-label">{row.label}</span>
                  <small>{row.value}</small>
                  <ChevronRight size={16} />
                </button>
              ))}
          {panel === "quality" && (
            <>
              {back(t("games.player.quality"))}
              {qualities.map((value) =>
                option(
                  value === "auto" ? choice === "auto" : choice !== "auto" && height === value,
                  qualityLabel(value),
                  () => {
                    onQuality(value);
                    close();
                  },
                ),
              )}
            </>
          )}
          {panel === "speed" && (
            <>
              {back(t("games.player.speed"))}
              {TRAILER_RATES.map((value) =>
                option(value === rate, rateLabel(value), () => {
                  onRate(value);
                  close();
                }),
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
