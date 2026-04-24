import { useEffect, useRef, useState } from "react";

export function useCountUp(target: number, duration = 1400, start = 0) {
  const [value, setValue] = useState(start);
  const startedFor = useRef<number | null>(null);

  useEffect(() => {
    if (target <= 0 || startedFor.current === target) return;
    startedFor.current = target;
    let raf = 0;
    const t0 = performance.now();
    const from = value;
    const tick = (now: number) => {
      const t = Math.min(1, (now - t0) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setValue(Math.round(from + (target - from) * eased));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, duration]);

  return value;
}

export function useRotatingIndex(length: number, intervalMs = 3200, paused = false) {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (paused || length <= 1) return;
    const id = setInterval(() => setI((x) => (x + 1) % length), intervalMs);
    return () => clearInterval(id);
  }, [length, intervalMs, paused]);
  return i;
}

export function useShortcut(
  combo: { key: string; meta?: boolean; ctrl?: boolean },
  handler: (e: KeyboardEvent) => void,
) {
  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const isTyping =
        target && /^(input|textarea|select)$/i.test(target.tagName);
      if (combo.key === "Escape" || !isTyping) {
        if (e.key.toLowerCase() === combo.key.toLowerCase()) {
          if (combo.meta && !(e.metaKey || e.ctrlKey)) return;
          handler(e);
        }
      }
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [combo.key, combo.meta, combo.ctrl, handler]);
}

export function isMac() {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform);
}
