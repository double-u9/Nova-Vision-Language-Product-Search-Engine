import { useEffect, useState } from "react";
import { MoonStar, SunMedium } from "lucide-react";
import { useTheme } from "next-themes";

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const isDark = mounted && resolvedTheme === "dark";
  const nextTheme = isDark ? "light" : "dark";
  const label = mounted ? `${isDark ? "Light" : "Dark"} mode` : "Theme";

  return (
    <button
      type="button"
      onClick={() => mounted && setTheme(nextTheme)}
      aria-label={mounted ? `Switch to ${nextTheme} mode` : "Toggle theme"}
      title={mounted ? `Switch to ${nextTheme} mode` : "Toggle theme"}
      className="flex items-center gap-2 rounded-full border border-border bg-card/60 px-3 py-1.5 text-xs text-muted-foreground backdrop-blur-sm transition hover:border-foreground/30 hover:text-foreground"
      data-testid="button-theme-toggle"
    >
      <span className="relative flex h-3.5 w-3.5 items-center justify-center">
        {isDark ? (
          <SunMedium className="h-3.5 w-3.5 text-accent" />
        ) : (
          <MoonStar className="h-3.5 w-3.5 text-accent" />
        )}
      </span>
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}
