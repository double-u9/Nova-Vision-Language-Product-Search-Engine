import { useState } from "react";
import { motion } from "framer-motion";
import { ArrowUpRight } from "lucide-react";
import { type ProductResult, imageUrl } from "@/lib/nova-api";

interface Props {
  product: ProductResult;
  onRefine: (productId: string) => void;
  index: number;
  topScore: number;
}

const HEIGHTS = [240, 300, 260, 340, 280, 320, 270, 310];

export function ProductCard({ product, onRefine, index, topScore }: Props) {
  const [loaded, setLoaded] = useState(false);
  const [errored, setErrored] = useState(false);
  const h = HEIGHTS[index % HEIGHTS.length];
  const initials = product.product_id.slice(0, 3).toUpperCase();

  // Match strength normalised against top result so the bar always reads
  const relStrength = topScore > 0 ? Math.max(0.18, product.score / topScore) : 1;
  const matchPct = (product.score * 100).toFixed(1);

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{
        duration: 0.45,
        delay: Math.min(index, 14) * 0.025,
        ease: [0.22, 1, 0.36, 1],
      }}
      className="group relative overflow-hidden rounded-xl border border-card-border bg-card transition-all duration-300 hover:border-foreground/15 hover:shadow-[var(--card-hover-shadow)]"
      data-testid={`card-product-${product.product_id}`}
    >
      {/* Index numeral */}
      <div className="pointer-events-none absolute left-3 top-3 z-20">
        <div className="rounded-full bg-background/85 px-2 py-0.5 font-mono text-[10px] tabular-nums tracking-wider text-foreground/70 backdrop-blur-md ring-1 ring-border/50">
          {String(index + 1).padStart(2, "0")}
        </div>
      </div>

      <div
        className="relative w-full overflow-hidden bg-muted"
        style={{ height: h }}
      >
        {!errored ? (
          <img
            src={imageUrl(product.image_path)}
            alt={product.product_id}
            onLoad={() => setLoaded(true)}
            onError={() => setErrored(true)}
            className={`h-full w-full object-cover transition-all duration-700 group-hover:scale-[1.04] ${
              loaded ? "opacity-100" : "opacity-0"
            }`}
            loading="lazy"
          />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-gradient-to-br from-secondary via-muted to-secondary px-4 transition-transform duration-700 group-hover:scale-[1.03]">
            <div className="font-serif text-5xl font-light italic text-muted-foreground/50">
              {initials}
            </div>
            <div className="text-center font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground/60">
              No preview
            </div>
          </div>
        )}

        {/* Gradient sheen on hover */}
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-foreground/65 via-foreground/10 to-transparent opacity-0 transition-opacity duration-400 group-hover:opacity-100" />

        {/* "More like this" CTA */}
        <div className="absolute inset-x-3 bottom-3 translate-y-3 opacity-0 transition-all duration-300 ease-out group-hover:translate-y-0 group-hover:opacity-100">
          <button
            type="button"
            onClick={() => onRefine(product.product_id)}
            className="flex w-full items-center justify-between gap-2 rounded-full bg-background/95 px-3.5 py-2 text-xs font-medium text-foreground shadow-sm backdrop-blur-md transition hover:bg-background"
            data-testid={`button-refine-${product.product_id}`}
          >
            <span>More like this</span>
            <ArrowUpRight className="h-3.5 w-3.5 transition-transform duration-200 group-hover:rotate-12" />
          </button>
        </div>
      </div>

      {/* Match strength bar */}
      <div className="relative h-[3px] w-full bg-secondary">
        <motion.div
          initial={{ scaleX: 0 }}
          animate={{ scaleX: relStrength }}
          transition={{ duration: 0.9, delay: 0.2 + index * 0.02, ease: [0.22, 1, 0.36, 1] }}
          style={{ transformOrigin: "left" }}
          className="absolute inset-y-0 left-0 w-full bg-accent"
        />
      </div>

      <div className="flex items-baseline justify-between gap-2 px-3 py-2.5">
        <span
          className="truncate font-mono text-[11px] text-muted-foreground"
          title={product.product_id}
        >
          {product.product_id}
        </span>
        <span className="font-mono text-[11px] tabular-nums text-foreground/75">
          {matchPct}<span className="ml-0.5 text-muted-foreground/70">%</span>
        </span>
      </div>
    </motion.div>
  );
}
