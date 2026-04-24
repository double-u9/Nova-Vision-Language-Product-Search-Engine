import { motion } from "framer-motion";
import { Wand2, X } from "lucide-react";

const REFINEMENTS = [
  "lighter",
  "darker",
  "more textured",
  "more minimal",
  "warmer tones",
  "structured fit",
];

interface Props {
  activeModifiers: string[];
  onToggle: (modifier: string) => void;
}

export function RefinePills({ activeModifiers, onToggle }: Props) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
      className="mb-6 space-y-3"
      data-testid="refine-pills"
    >
      {activeModifiers.length > 0 && (
        <div
          className="flex flex-wrap items-center gap-2"
          data-testid="active-refinement-chips"
        >
          {activeModifiers.map((modifier) => (
            <button
              key={modifier}
              type="button"
              onClick={() => onToggle(modifier)}
              className="inline-flex items-center gap-1.5 rounded-full border border-accent/30 bg-accent/10 px-3 py-1 text-xs text-foreground transition hover:border-accent hover:bg-accent/15"
              data-testid={`active-refine-${modifier.replace(/\s+/g, "-")}`}
            >
              <span>{modifier}</span>
              <X className="h-3 w-3 text-muted-foreground" />
            </button>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <span className="flex items-center gap-1.5 text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
          <Wand2 className="h-3 w-3" />
          Refine
        </span>
        {REFINEMENTS.map((modifier) => {
          const isActive = activeModifiers.includes(modifier);
          return (
            <button
              key={modifier}
              type="button"
              onClick={() => onToggle(modifier)}
              className={`group rounded-full border px-3 py-1 text-xs backdrop-blur-sm transition-all hover:-translate-y-0.5 ${
                isActive
                  ? "border-accent/40 bg-accent/10 text-foreground"
                  : "border-border bg-card/50 text-muted-foreground hover:border-foreground/30 hover:text-foreground"
              }`}
              aria-pressed={isActive}
              data-testid={`refine-${modifier.replace(/\s+/g, "-")}`}
            >
              {modifier}
              <span
                className={`ml-1 inline-block transition-all ${
                  isActive
                    ? "translate-x-0 opacity-100"
                    : "translate-x-0 opacity-0 group-hover:translate-x-0.5 group-hover:opacity-100"
                }`}
              >
                {isActive ? "x" : "->"}
              </span>
            </button>
          );
        })}
      </div>
    </motion.div>
  );
}
