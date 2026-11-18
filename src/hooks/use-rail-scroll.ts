import { useEffect, useRef, useState } from "react";

const DRAG_THRESHOLD = 5;
const LINE_HEIGHT = 40;

/**
 * Mouse-friendly horizontal rail: the vertical wheel scrolls sideways (and hands back to the
 * page at either end), mouse drags pan it, and the reported edges drive arrow buttons and fades.
 * Touch and trackpads keep native scrolling; keyboard focus scrolling is untouched.
 * Returns a callback ref, so a rail that mounts later (say, once more items load) still binds.
 */
export function useRailScroll() {
  const [node, setNode] = useState<HTMLElement | null>(null);
  const [edges, setEdges] = useState({ start: false, end: false });
  const target = useRef<number | null>(null),
    frame = useRef(0);

  useEffect(() => {
    if (!node) return;
    const rtl = () => getComputedStyle(node).direction === "rtl";
    const max = () => node.scrollWidth - node.clientWidth;
    // Chromium reports RTL scroll positions as zero or negative.
    const offset = () => Math.abs(node.scrollLeft);
    const measure = () => {
      const position = offset(),
        limit = max();
      const start = position > 1,
        end = position < limit - 1;
      // Runs on every scroll frame; keep the same state object so React skips the render.
      setEdges((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
    };
    const animate = () => {
      if (target.current === null) return;
      // The rail can shrink mid-animation (a filter, a resize): aim at what is still reachable.
      const goal = Math.max(0, Math.min(max(), target.current));
      const current = offset(),
        next = current + (goal - current) * 0.22;
      const done = Math.abs(goal - next) < 0.5;
      node.scrollLeft = rtl() ? -(done ? goal : next) : done ? goal : next;
      // A write the browser clamped back means the goal cannot be reached; stop there.
      if (done || Math.abs(offset() - current) < 0.1) target.current = null;
      else frame.current = requestAnimationFrame(animate);
    };
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
      const limit = max();
      if (limit <= 0) return;
      const delta = event.deltaY * (event.deltaMode === 1 ? LINE_HEIGHT : 1);
      const from = target.current ?? offset();
      // At either end the wheel belongs to the page again.
      if ((delta < 0 && from <= 0) || (delta > 0 && from >= limit)) return;
      event.preventDefault();
      target.current = Math.max(0, Math.min(limit, from + delta));
      cancelAnimationFrame(frame.current);
      if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
        node.scrollLeft = rtl() ? -target.current : target.current;
        target.current = null;
      } else frame.current = requestAnimationFrame(animate);
    };

    let drag: { id: number; x: number; start: number; moved: boolean } | null = null;
    const down = (event: PointerEvent) => {
      if (event.pointerType !== "mouse" || event.button !== 0 || max() <= 0) return;
      drag = { id: event.pointerId, x: event.clientX, start: node.scrollLeft, moved: false };
    };
    const move = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.id) return;
      // Released outside before the rail captured the pointer: its pointerup never came here.
      if (!drag.moved && (event.buttons & 1) === 0) {
        drag = null;
        return;
      }
      const distance = event.clientX - drag.x;
      if (!drag.moved) {
        if (Math.abs(distance) < DRAG_THRESHOLD) return;
        drag.moved = true;
        target.current = null;
        cancelAnimationFrame(frame.current);
        node.setPointerCapture(event.pointerId);
        node.dataset.dragging = "true";
      }
      node.scrollLeft = drag.start - distance;
    };
    const up = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.id) return;
      const moved = drag.moved;
      drag = null;
      delete node.dataset.dragging;
      if (node.hasPointerCapture(event.pointerId)) node.releasePointerCapture(event.pointerId);
      // A drag is not a choice: swallow the click that follows it. A cancelled
      // pointer gets no click, so a listener left behind would eat the next real one.
      if (moved && event.type === "pointerup")
        node.addEventListener(
          "click",
          (click) => {
            click.preventDefault();
            click.stopPropagation();
          },
          { capture: true, once: true },
        );
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    // Swapping the cards (a filter) can change the overflow without resizing the rail itself.
    const cards = new MutationObserver(measure);
    cards.observe(node, { childList: true });
    node.addEventListener("scroll", measure, { passive: true });
    node.addEventListener("wheel", wheel, { passive: false });
    node.addEventListener("pointerdown", down);
    node.addEventListener("pointermove", move);
    node.addEventListener("pointerup", up);
    node.addEventListener("pointercancel", up);
    // A press that leaves before becoming a drag is over for the rail; a later press that
    // re-enters with the button down must not inherit its origin.
    const leave = () => {
      if (drag && !drag.moved) drag = null;
    };
    node.addEventListener("pointerleave", leave);
    return () => {
      cancelAnimationFrame(frame.current);
      observer.disconnect();
      cards.disconnect();
      node.removeEventListener("scroll", measure);
      node.removeEventListener("wheel", wheel);
      node.removeEventListener("pointerdown", down);
      node.removeEventListener("pointermove", move);
      node.removeEventListener("pointerup", up);
      node.removeEventListener("pointercancel", up);
      node.removeEventListener("pointerleave", leave);
    };
  }, [node]);

  /** Moves a page toward the start (-1) or end (1), respecting writing direction. */
  const page = (step: -1 | 1) => {
    if (!node) return;
    const rtl = getComputedStyle(node).direction === "rtl";
    node.scrollBy({
      left: step * node.clientWidth * 0.8 * (rtl ? -1 : 1),
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    });
  };

  /** Jumps back to the start, dropping any wheel animation still heading elsewhere. */
  const reset = () => {
    cancelAnimationFrame(frame.current);
    target.current = null;
    node?.scrollTo({ left: 0 });
  };

  return { ref: setNode, edges, page, reset };
}
