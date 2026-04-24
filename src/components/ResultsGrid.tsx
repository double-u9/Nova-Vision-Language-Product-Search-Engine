import { motion } from "framer-motion";
import { ProductCard } from "./ProductCard";
import { type ProductResult } from "@/lib/nova-api";

interface Props {
  results: ProductResult[];
  loading?: boolean;
  onRefine: (productId: string) => void;
}

const SKEL_HEIGHTS = [240, 300, 260, 340, 280, 320, 270, 310, 250, 330, 290, 260];

export function ResultsGrid({ results, loading, onRefine }: Props) {
  if (loading && results.length === 0) {
    return (
      <div className="masonry" data-testid="results-loading">
        {SKEL_HEIGHTS.map((h, i) => (
          <motion.div
            key={i}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.04 }}
            className="overflow-hidden rounded-xl border border-card-border bg-card"
          >
            <div className="shimmer w-full" style={{ height: h }} />
            <div className="h-[3px] w-full bg-secondary" />
            <div className="flex items-center justify-between gap-2 px-3 py-2.5">
              <div className="shimmer h-3 w-20 rounded" />
              <div className="shimmer h-3 w-10 rounded" />
            </div>
          </motion.div>
        ))}
      </div>
    );
  }

  if (results.length === 0) return null;

  const topScore = results[0]?.score ?? 1;

  return (
    <div className="masonry" data-testid="results-grid">
      {results.map((p, i) => (
        <ProductCard
          key={`${p.product_id}-${i}`}
          product={p}
          index={i}
          topScore={topScore}
          onRefine={onRefine}
        />
      ))}
    </div>
  );
}
