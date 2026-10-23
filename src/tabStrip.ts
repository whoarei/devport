import { useLayoutEffect, type RefObject } from "react";

export function tabNavigationTarget(ids: string[], current: string, key: string): string | undefined {
  if (!ids.length || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(key)) return undefined;
  if (key === "Home") return ids[0];
  if (key === "End") return ids[ids.length - 1];
  const index = ids.indexOf(current);
  return ids[index < 0 ? 0 : (index + (key === "ArrowRight" ? 1 : -1) + ids.length) % ids.length];
}

/** Reveal only horizontally: scrollIntoView would also move surrounding panes.
 * Rects include CSS zoom while scrollLeft uses unscaled CSS pixels. */
export function revealActiveTab(strip: HTMLElement, tab: HTMLElement): void {
  if (!strip.clientWidth || !strip.offsetWidth) return;
  const viewport = strip.getBoundingClientRect(), item = tab.getBoundingClientRect();
  const scale = viewport.width / strip.offsetWidth;
  if (!scale) return;
  const inset = strip.querySelector?.<HTMLElement>("[data-tab-strip-inset]")?.offsetWidth ?? 0;
  const left = viewport.left + (strip.clientLeft + inset) * scale;
  const right = viewport.left + (strip.clientLeft + strip.clientWidth) * scale;
  if (item.left < left) strip.scrollLeft += (item.left - left) / scale;
  else if (item.right > right) strip.scrollLeft += (item.width > right - left ? item.left - left : item.right - right) / scale;
}

export function useRevealActiveTab(ref: RefObject<HTMLDivElement>, active: string | null, visible = true) {
  useLayoutEffect(() => {
    const strip = ref.current;
    if (!strip || !visible) return;
    const reveal = () => {
      const tab = strip.querySelector<HTMLElement>('[data-active-tab="true"]');
      if (tab) revealActiveTab(strip, tab);
    };
    reveal();
    const observer = new ResizeObserver(reveal);
    observer.observe(strip);
    return () => observer.disconnect();
  }, [ref, active, visible]);
}
