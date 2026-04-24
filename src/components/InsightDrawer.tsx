import { motion, AnimatePresence } from "framer-motion";
import { X, Zap, Database, Sparkles, Activity } from "lucide-react";
import { type SearchResponse, type HealthResponse } from "@/lib/nova-api";

interface Props {
  open: boolean;
  onClose: () => void;
  response: SearchResponse | null;
  health: HealthResponse | null;
  latencyHistory: number[];
}

function Stat({
  label,
  value,
  hint,
  icon,
}: {
  label: string;
  value: string;
  hint?: string;
  icon?: React.ReactNode;
}) {
  return (
    <div className="border-b border-border py-4 last:border-0">
      <div className="mb-1 flex items-center gap-1.5 text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
        {icon}
        <span>{label}</span>
      </div>
      <div className="font-serif text-2xl font-light tracking-tight text-foreground">
        {value}
      </div>
      {hint && (
        <div className="mt-1 text-xs text-muted-foreground">{hint}</div>
      )}
    </div>
  );
}

function Sparkline({ data, height = 48 }: { data: number[]; height?: number }) {
  if (data.length < 2) {
    return (
      <div
        className="flex items-center justify-center text-[11px] text-muted-foreground/60"
        style={{ height }}
      >
        Run more queries to see the trend.
      </div>
    );
  }
  const w = 280;
  const h = height;
  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const range = max - min || 1;
  const step = w / (data.length - 1);
  const points = data
    .map((v, i) => `${i * step},${h - ((v - min) / range) * (h - 6) - 3}`)
    .join(" ");
  const areaPath = `M0,${h} L${points} L${w},${h} Z`;
  const linePath = `M${points}`;
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      className="h-12 w-full"
      preserveAspectRatio="none"
    >
      <path d={areaPath} fill="hsl(var(--accent))" fillOpacity="0.10" />
      <path
        d={linePath}
        fill="none"
        stroke="hsl(var(--accent))"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {data.map((v, i) => (
        <circle
          key={i}
          cx={i * step}
          cy={h - ((v - min) / range) * (h - 6) - 3}
          r={i === data.length - 1 ? 2.5 : 1}
          fill="hsl(var(--accent))"
        />
      ))}
    </svg>
  );
}

export function InsightDrawer({
  open,
  onClose,
  response,
  health,
  latencyHistory,
}: Props) {
  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 z-40 bg-foreground/20 backdrop-blur-sm"
            data-testid="drawer-backdrop"
          />
          <motion.aside
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ type: "spring", damping: 28, stiffness: 240 }}
            className="fixed right-0 top-0 z-50 flex h-full w-full max-w-md flex-col border-l border-border bg-background shadow-2xl"
            data-testid="drawer-insight"
          >
            <header className="flex items-center justify-between border-b border-border px-6 py-5">
              <div>
                <div className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                  Behind the search
                </div>
                <h2 className="mt-0.5 font-serif text-xl font-light tracking-tight">
                  Signal & latency
                </h2>
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close insights"
                className="rounded-full p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground"
                data-testid="button-close-drawer"
              >
                <X className="h-4 w-4" />
              </button>
            </header>

            <div className="flex-1 overflow-y-auto px-6">
              {response ? (
                <>
                  <Stat
                    label="Last query"
                    value={response.query_type}
                    hint={
                      response.alpha != null
                        ? `Blend α ${response.alpha.toFixed(2)} — text ${(response.alpha * 100).toFixed(
                            0,
                          )}% / image ${((1 - response.alpha) * 100).toFixed(0)}%`
                        : "Single-modality"
                    }
                    icon={<Sparkles className="h-3 w-3" />}
                  />
                  <Stat
                    label="Latency"
                    value={`${response.latency_ms.toFixed(0)} ms`}
                    hint={
                      response.cache_hit
                        ? "Served from cache"
                        : "Cold computation"
                    }
                    icon={<Zap className="h-3 w-3" />}
                  />
                  <Stat
                    label="Returned"
                    value={`${response.results.length} results`}
                    hint={
                      response.results[0]
                        ? `Top match ${(response.results[0].score * 100).toFixed(
                            1,
                          )}% similarity`
                        : undefined
                    }
                  />
                </>
              ) : (
                <div className="py-12 text-center text-sm text-muted-foreground">
                  Run a search to see signal data.
                </div>
              )}

              {/* Latency sparkline */}
              <div className="mt-6 border-t border-border pt-6">
                <div className="mb-2 flex items-center justify-between">
                  <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                    <Activity className="h-3 w-3" />
                    Recent latency
                  </div>
                  {latencyHistory.length > 0 && (
                    <div className="font-mono text-[11px] tabular-nums text-muted-foreground">
                      avg{" "}
                      {Math.round(
                        latencyHistory.reduce((a, b) => a + b, 0) /
                          latencyHistory.length,
                      )}
                      {" ms"}
                    </div>
                  )}
                </div>
                <Sparkline data={latencyHistory} />
              </div>

              {health && (
                <div className="mt-6 border-t border-border pt-6">
                  <div className="mb-3 text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                    Catalog
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                        <Database className="h-3 w-3" />
                        Index size
                      </div>
                      <div className="mt-1 font-mono text-base text-foreground">
                        {health.index_size.toLocaleString()}
                      </div>
                    </div>
                    <div>
                      <div className="text-[11px] text-muted-foreground">
                        Served
                      </div>
                      <div className="mt-1 font-mono text-base text-foreground">
                        {health.requests_served.toLocaleString()}
                      </div>
                    </div>
                    <div>
                      <div className="text-[11px] text-muted-foreground">
                        Avg. latency
                      </div>
                      <div className="mt-1 font-mono text-base text-foreground">
                        {health.avg_latency_ms.toFixed(0)} ms
                      </div>
                    </div>
                    <div>
                      <div className="text-[11px] text-muted-foreground">
                        Status
                      </div>
                      <div className="mt-1 flex items-center gap-1.5 font-mono text-base text-foreground">
                        <span className="relative flex h-2 w-2">
                          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-60" />
                          <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
                        </span>
                        {health.status}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              <div className="mt-8 border-t border-border pt-6 pb-6">
                <div className="mb-2 text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                  How it works
                </div>
                <p className="text-sm leading-relaxed text-muted-foreground">
                  Each query — words, image, or both — is encoded into a 512-d
                  CLIP embedding and matched against the catalog with FAISS
                  approximate nearest neighbors. Hybrid blends the two
                  embeddings linearly with α before search.
                </p>
              </div>
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}
