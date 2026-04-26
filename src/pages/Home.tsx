import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Info, AlertCircle } from "lucide-react";
import {
  SearchBar,
  type SearchBarHandle,
  type SearchPayload,
} from "@/components/SearchBar";
import { ResultsGrid } from "@/components/ResultsGrid";
import { InsightDrawer } from "@/components/InsightDrawer";
import { RefinePills } from "@/components/RefinePills";
import { AnimatedCounter } from "@/components/AnimatedCounter";
import { ThemeToggle } from "@/components/ThemeToggle";
import {
  type SearchResponse,
  type HealthResponse,
  type ProductResult,
  searchText,
  searchImage,
  searchHybrid,
  searchSimilar,
  getHealth,
} from "@/lib/nova-api";
import { useShortcut } from "@/lib/hooks";

type Mode = "idle" | "loading" | "ready" | "error";
type SimilarPayload = { kind: "similar"; productId: string; query?: string };
type ExecutablePayload = SearchPayload | SimilarPayload;
type SearchContext =
  | { kind: "text"; baseQuery: string }
  | { kind: "image"; file: File }
  | { kind: "hybrid"; baseQuery: string; file: File; alpha: number }
  | { kind: "similar"; productId: string };

const IMAGE_REFINEMENT_ALPHA = 0.35;

function composeQuery(baseQuery: string, modifiers: string[]) {
  return [baseQuery.trim(), ...modifiers].filter(Boolean).join(", ");
}

function labelForContext(context: SearchContext) {
  switch (context.kind) {
    case "text":
    case "hybrid":
      return context.baseQuery;
    case "image":
      return "Visual reference";
    case "similar":
      return `More like ${context.productId}`;
  }
}

function buildPayloadFromContext(
  context: SearchContext,
  modifiers: string[],
): ExecutablePayload {
  switch (context.kind) {
    case "text":
      return {
        kind: "text",
        text: composeQuery(context.baseQuery, modifiers),
      };
    case "hybrid":
      return {
        kind: "hybrid",
        text: composeQuery(context.baseQuery, modifiers),
        file: context.file,
        alpha: context.alpha,
      };
    case "image":
      if (modifiers.length === 0) {
        return { kind: "image", file: context.file };
      }
      return {
        kind: "hybrid",
        text: modifiers.join(", "),
        file: context.file,
        alpha: IMAGE_REFINEMENT_ALPHA,
      };
    case "similar":
      return {
        kind: "similar",
        productId: context.productId,
        query: modifiers.length > 0 ? modifiers.join(", ") : undefined,
      };
  }
}

export default function Home() {
  const [mode, setMode] = useState<Mode>("idle");
  const [response, setResponse] = useState<SearchResponse | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resultLabel, setResultLabel] = useState<string>("");
  const [searchContext, setSearchContext] = useState<SearchContext | null>(null);
  const [activeRefinements, setActiveRefinements] = useState<string[]>([]);
  const [lastPayload, setLastPayload] = useState<ExecutablePayload | null>(null);
  const [latencyHistory, setLatencyHistory] = useState<number[]>([]);
  const searchBarRef = useRef<SearchBarHandle>(null);

  useEffect(() => {
    let cancelled = false;
    getHealth()
      .then((h) => !cancelled && setHealth(h))
      .catch(() => {});
    const id = setInterval(() => {
      getHealth()
        .then((h) => !cancelled && setHealth(h))
        .catch(() => {});
    }, 30000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const executeSearch = useCallback(async (
    payload: ExecutablePayload,
    nextLabel: string,
    nextRefinements: string[],
  ) => {
    setMode("loading");
    setError(null);
    setLastPayload(payload);
    setResultLabel(nextLabel);
    setActiveRefinements(nextRefinements);

    try {
      let res: SearchResponse;
      if (payload.kind === "text") {
        res = await searchText(payload.text, 30);
      } else if (payload.kind === "image") {
        res = await searchImage(payload.file, 30);
      } else if (payload.kind === "similar") {
        res = await searchSimilar(payload.productId, payload.query, 30);
      } else {
        res = await searchHybrid(payload.text, payload.file, payload.alpha, 30);
      }
      setResponse(res);
      setLatencyHistory((h) => [...h.slice(-11), res.latency_ms]);
      setMode("ready");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Search failed");
      setMode("error");
    }
  }, []);

  const runSearch = useCallback(
    (payload: SearchPayload) => {
      let nextContext: SearchContext;

      if (payload.kind === "text") {
        nextContext = { kind: "text", baseQuery: payload.text.trim() };
      } else if (payload.kind === "image") {
        nextContext = { kind: "image", file: payload.file };
      } else {
        nextContext = {
          kind: "hybrid",
          baseQuery: payload.text.trim(),
          file: payload.file,
          alpha: payload.alpha,
        };
      }

      setSearchContext(nextContext);
      void executeSearch(buildPayloadFromContext(nextContext, []), labelForContext(nextContext), []);
    },
    [executeSearch],
  );

  const handleMoreLikeThis = useCallback(
    (productId: string) => {
      const nextContext: SearchContext = { kind: "similar", productId };
      setSearchContext(nextContext);
      void executeSearch(
        buildPayloadFromContext(nextContext, []),
        labelForContext(nextContext),
        [],
      );
    },
    [executeSearch],
  );

  const handleRefineToggle = useCallback(
    (modifier: string) => {
      if (!searchContext) {
        return;
      }

      const nextRefinements = activeRefinements.includes(modifier)
        ? activeRefinements.filter((item) => item !== modifier)
        : [...activeRefinements, modifier];

      void executeSearch(
        buildPayloadFromContext(searchContext, nextRefinements),
        labelForContext(searchContext),
        nextRefinements,
      );
    },
    [activeRefinements, executeSearch, searchContext],
  );

  // Keyboard shortcuts
  useShortcut({ key: "k", meta: true }, (e) => {
    e.preventDefault();
    searchBarRef.current?.focus();
  });
  useShortcut({ key: "/" }, (e) => {
    e.preventDefault();
    searchBarRef.current?.focus();
  });
  useShortcut({ key: "Escape" }, () => {
    if (drawerOpen) setDrawerOpen(false);
  });

  const heroLifted = mode !== "idle";
  const hasImageRef = useMemo(
    () =>
      lastPayload?.kind === "image" ||
      lastPayload?.kind === "hybrid" ||
      lastPayload?.kind === "similar",
    [lastPayload],
  );
  const indexSize = health?.index_size ?? 0;

  return (
    <div className="relative min-h-screen w-full overflow-hidden bg-background text-foreground">
      {/* Ambient warm glow */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[680px] opacity-80">
        <div
          className="absolute left-1/2 top-[-20%] h-[640px] w-[1100px] -translate-x-1/2 rounded-full blur-[120px]"
          style={{
            background: "var(--hero-glow-primary)",
          }}
        />
        <div
          className="absolute left-[10%] top-[40%] h-[400px] w-[600px] rounded-full blur-[120px]"
          style={{
            background: "var(--hero-glow-secondary)",
          }}
        />
      </div>
      <div className="pointer-events-none absolute inset-0 grain opacity-50" />

      <header className="relative z-10 mx-auto flex max-w-7xl items-center justify-between px-6 pt-6 sm:px-10 sm:pt-8">
        <div className="flex items-baseline gap-3">
          <a
            href={import.meta.env.BASE_URL}
            className="group/brand font-serif text-2xl font-light tracking-tight transition-all hover:tracking-[-0.01em]"
            data-testid="brand-name"
          >
            Nova
            <span className="ml-0.5 inline-block h-1.5 w-1.5 rounded-full bg-accent align-middle transition-transform duration-500 group-hover/brand:scale-125" />
          </a>
          <span className="hidden font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground sm:inline">
            Visual Atelier
          </span>
        </div>
        <div className="flex items-center gap-2">
          <ThemeToggle />
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            className="flex items-center gap-2 rounded-full border border-border bg-card/60 px-3 py-1.5 text-xs text-muted-foreground backdrop-blur-sm transition hover:border-foreground/30 hover:text-foreground"
            data-testid="button-open-drawer"
          >
            <Info className="h-3 w-3" />
            <span className="hidden sm:inline">Behind the search</span>
            {response && (
              <>
                <span className="hidden h-3 w-px bg-border sm:inline-block" />
                <span className="font-mono tabular-nums text-foreground">
                  {response.latency_ms.toFixed(0)} ms
                </span>
              </>
            )}
          </button>
        </div>
      </header>

      <motion.section
        layout
        transition={{ type: "spring", damping: 26, stiffness: 220 }}
        className={`relative z-10 mx-auto max-w-3xl px-6 sm:px-10 ${
          heroLifted ? "pt-10 pb-6" : "pt-20 pb-10 sm:pt-28"
        }`}
      >
        <AnimatePresence mode="wait">
          {!heroLifted && (
            <motion.div
              key="hero-copy"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.4 }}
              className="mb-10 text-center"
            >
              <motion.div
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.05 }}
                className="mb-5 inline-flex items-center gap-2 rounded-full border border-border bg-card/60 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground backdrop-blur-sm"
              >
                <span className="relative flex h-1.5 w-1.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-70" />
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-accent" />
                </span>
                Vision-language search · live
              </motion.div>

              <motion.h1
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.12, duration: 0.6 }}
                className="font-serif text-5xl font-light leading-[1.02] tracking-[-0.02em] sm:text-7xl"
              >
                Find the piece you're{" "}
                <em className="italic font-normal text-foreground/95">
                  picturing
                </em>
                <span className="text-accent">.</span>
              </motion.h1>

              <motion.p
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.22, duration: 0.5 }}
                className="mx-auto mt-6 max-w-xl text-base leading-relaxed text-muted-foreground sm:text-lg"
              >
                Type a description, drop in an image, or do both — Nova reads
                meaning across words and pixels and brings back the closest
                matches.
              </motion.p>

              {/* Trust micro-row */}
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.4, duration: 0.5 }}
                className="mx-auto mt-7 flex max-w-xl flex-wrap items-center justify-center gap-x-5 gap-y-2 font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground"
              >
                <span className="flex items-baseline gap-1.5">
                  <AnimatedCounter
                    value={indexSize}
                    className="font-serif text-base font-normal normal-case tracking-normal text-foreground"
                  />
                  pieces indexed
                </span>
                <span className="hidden h-3 w-px bg-border sm:inline-block" />
                <span>Sub-100ms</span>
                <span className="hidden h-3 w-px bg-border sm:inline-block" />
                <span>512-d CLIP · FAISS</span>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        <SearchBar
          ref={searchBarRef}
          onSearch={runSearch}
          isSearching={mode === "loading"}
        />

        {health?.startup_error && (
          <div className="mt-4 rounded-2xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-muted-foreground">
            <div className="font-medium text-foreground">
              The search backend started in degraded mode.
            </div>
            <div className="mt-1 break-words">{health.startup_error}</div>
          </div>
        )}

        {!health?.startup_error && health && health.status !== "ok" && (
          <div className="mt-4 rounded-2xl border border-border bg-card/70 px-4 py-3 text-sm text-muted-foreground">
            The search engine is still warming up. The first local start can take
            a minute while CLIP weights load and the index initializes.
          </div>
        )}
      </motion.section>

      <main className="relative z-10 mx-auto max-w-7xl px-6 pb-24 sm:px-10">
        {mode === "error" && (
          <div
            className="mx-auto mb-6 flex max-w-2xl items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm"
            data-testid="error-banner"
          >
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <div>
              <div className="font-medium text-foreground">
                Couldn't reach the search engine.
              </div>
              <div className="mt-0.5 text-muted-foreground">{error}</div>
            </div>
          </div>
        )}

        {mode !== "idle" && (
          <>
            <div className="mb-5 flex items-baseline justify-between gap-4 border-b border-border pb-3">
              <div className="min-w-0">
                <div className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                  {mode === "loading" ? "Searching" : "Results for"}
                </div>
                <h2 className="mt-0.5 truncate font-serif text-xl font-light tracking-tight sm:text-2xl">
                  {resultLabel || "—"}
                  {hasImageRef && (
                    <span className="ml-2 font-mono text-xs uppercase tracking-[0.14em] text-muted-foreground">
                      + image
                    </span>
                  )}
                </h2>
              </div>
              {response && mode === "ready" && (
                <div className="shrink-0 text-right">
                  <div className="font-mono text-[11px] text-muted-foreground">
                    {response.results.length} matches
                  </div>
                  <div className="font-mono text-[11px] tabular-nums text-muted-foreground">
                    {response.latency_ms.toFixed(0)} ms
                    {response.cache_hit && " · cached"}
                  </div>
                </div>
              )}
            </div>

            {mode === "ready" && response && (
              <RefinePills
                activeModifiers={activeRefinements}
                onToggle={handleRefineToggle}
              />
            )}
          </>
        )}

        <ResultsGrid
          results={mode === "loading" ? [] : response?.results ?? []}
          loading={mode === "loading"}
          onRefine={handleMoreLikeThis}
        />

        {mode === "idle" && (
          <div className="mx-auto mt-10 max-w-2xl text-center">
            <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
              Drag an image anywhere · ⌘K to focus · Enter to search
            </p>
          </div>
        )}
      </main>

      <footer className="relative z-10 mx-auto max-w-7xl border-t border-border px-6 py-6 sm:px-10">
        <div className="flex flex-col items-center justify-between gap-3 sm:flex-row">
          <div className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-60" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
            </span>
            {health ? `${health.requests_served.toLocaleString()} searches served` : "Connecting…"}
          </div>
          <div className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
            Nova · Vision-Language Atelier
          </div>
        </div>
      </footer>

      <InsightDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        response={response}
        health={health}
        latencyHistory={latencyHistory}
      />
    </div>
  );
}
