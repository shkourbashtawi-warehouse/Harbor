import { useEffect, useRef, useState } from "react";
import { isSceneCut } from "@/lib/games/ambient-light";

// A tiny frame is enough once it is blurred across the backdrop, and keeps every draw cheap.
const WIDTH = 48,
  HEIGHT = 27;
// About 15 updates a second follows motion closely without drawing every frame of 60 fps video.
const MIN_FRAME_GAP_MS = 66;
// Share of each new frame blended over the light: a short trail that hides compression flicker.
const BLEND = 0.35;

type FrameVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (callback: () => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

/**
 * Ambient light like YouTube's: the playing frame, drawn small and blurred behind the player.
 * It updates with the video's own frames, lands at once on a cut and eases through motion.
 * Cut detection reads a 48x27 sample; if a cross-origin source forbids that, it only eases.
 */
export function GameTrailerAmbient({ video }: { video: HTMLVideoElement | null }) {
  const light = useRef<HTMLCanvasElement>(null);
  const [lit, setLit] = useState(false);

  useEffect(() => {
    const target = video as FrameVideo | null;
    const output = light.current?.getContext("2d", { alpha: false });
    if (!target || !output) return;
    const sample = document.createElement("canvas");
    sample.width = WIDTH;
    sample.height = HEIGHT;
    const reader = sample.getContext("2d", { willReadFrequently: true });
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    let previous: Uint8ClampedArray | null = null,
      readable = !!reader,
      painted = false,
      last = 0,
      stopped = false,
      handle = 0,
      timer: ReturnType<typeof setTimeout> | undefined;

    const paint = (instant: boolean) => {
      if (target.readyState < 2 || !target.videoWidth || document.fullscreenElement) return;
      let cut = instant || !painted;
      if (readable && reader) {
        try {
          reader.drawImage(target, 0, 0, WIDTH, HEIGHT);
          const pixels = reader.getImageData(0, 0, WIDTH, HEIGHT).data;
          if (isSceneCut(previous, pixels)) cut = true;
          previous = pixels;
        } catch {
          // A tainted source: keep drawing, just without telling cuts from motion.
          readable = false;
        }
      }
      output.globalAlpha = cut || reduced ? 1 : BLEND;
      output.drawImage(target, 0, 0, WIDTH, HEIGHT);
      if (!painted) {
        painted = true;
        setLit(true);
      }
    };
    const onFrame = () => {
      if (stopped) return;
      const now = performance.now();
      if (!document.hidden && now - last >= (reduced ? 500 : MIN_FRAME_GAP_MS)) {
        last = now;
        paint(false);
      }
      schedule();
    };
    const schedule = () => {
      if (stopped) return;
      // Per-frame callbacks where supported; a timer elsewhere (older WebKit builds).
      if (target.requestVideoFrameCallback) handle = target.requestVideoFrameCallback(onFrame);
      else timer = setTimeout(onFrame, MIN_FRAME_GAP_MS);
    };
    // A jump in the timeline is a new picture: show it at once, even while paused.
    const jump = () => {
      if (!stopped) paint(true);
    };
    target.addEventListener("loadeddata", jump);
    target.addEventListener("seeked", jump);
    jump();
    schedule();
    return () => {
      stopped = true;
      // The next video starts dark rather than under the previous trailer's light.
      output.clearRect(0, 0, WIDTH, HEIGHT);
      setLit(false);
      if (handle) target.cancelVideoFrameCallback?.(handle);
      clearTimeout(timer);
      target.removeEventListener("loadeddata", jump);
      target.removeEventListener("seeked", jump);
    };
  }, [video]);

  return (
    <div className={`games-theater-ambient-live${lit ? " is-lit" : ""}`} aria-hidden="true">
      <canvas ref={light} width={WIDTH} height={HEIGHT} />
    </div>
  );
}
