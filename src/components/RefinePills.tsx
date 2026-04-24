import { motion } from "framer-motion";
import { Wand2 } from "lucide-react";

const REFINEMENTS = [
  "lighter",
  "darker",
  "more textured",
  "more minimal",
  "warmer tones",
  "structured fit",
];

interface Props {
  onRefine: (modifier: string) => void;
}

export function RefinePills({ onRefine }: Props) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
      className="mb-6 flex flex-wrap items-center gap-2"
      data-testid="refine-pills"
    >
      <span className="flex items-center gap-1.5 text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
        <Wand2 className="h-3 w-3" />
        Refine
      </span>
      {REFINEMENTS.map((r) => (
        <button
          key={r}
          type="button"
          onClick={() => onRefine(r)}
          className="group rounded-full border border-border bg-card/50 px-3 py-1 text-xs text-muted-foreground backdrop-blur-sm transition-all hover:-translate-y-0.5 hover:border-foreground/30 hover:text-foreground"
          data-testid={`refine-${r.replace(/\s+/g, "-")}`}
        >
          {r}
          <span className="ml-1 inline-block translate-x-0 opacity-0 transition-all group-hover:translate-x-0.5 group-hover:opacity-100">
            →
          </span>
        </button>
      ))}
    </motion.div>
  );
}
