import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ImageIcon, X, Search, Loader2, CornerDownLeft } from "lucide-react";
import { isMac, useRotatingIndex } from "@/lib/hooks";

export type SearchPayload =
  | { kind: "text"; text: string }
  | { kind: "image"; file: File }
  | { kind: "hybrid"; text: string; file: File; alpha: number };

export interface SearchBarHandle {
  focus: () => void;
  clear: () => void;
}

interface Props {
  onSearch: (payload: SearchPayload) => void;
  isSearching?: boolean;
  initialText?: string;
}

const PLACEHOLDERS = [
  "Linen overshirt, sand…",
  "Vintage leather satchel, cognac…",
  "Wide-leg trousers, charcoal wool…",
  "Ribbed knit, oat, oversized fit…",
  "White sneakers, minimal silhouette…",
];

const SUGGESTIONS = [
  "linen overshirt, sand",
  "white sneakers, minimal",
  "vintage leather satchel",
  "ribbed knit, oat",
  "wide-leg trousers, charcoal",
];

export const SearchBar = forwardRef<SearchBarHandle, Props>(function SearchBar(
  { onSearch, isSearching, initialText = "" },
  ref,
) {
  const [text, setText] = useState(initialText);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [alpha, setAlpha] = useState(0.5);
  const [dragOver, setDragOver] = useState(false);
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const placeholderIdx = useRotatingIndex(
    PLACEHOLDERS.length,
    3200,
    focused || !!text || !!file,
  );

  useImperativeHandle(ref, () => ({
    focus: () => inputRef.current?.focus(),
    clear: () => {
      setText("");
      setFile(null);
    },
  }));

  useEffect(() => {
    if (!file) {
      setPreview(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = useCallback(() => {
    const trimmed = text.trim();
    if (file && trimmed) {
      onSearch({ kind: "hybrid", text: trimmed, file, alpha });
    } else if (file) {
      onSearch({ kind: "image", file });
    } else if (trimmed) {
      onSearch({ kind: "text", text: trimmed });
    }
  }, [text, file, alpha, onSearch]);

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f && f.type.startsWith("image/")) setFile(f);
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    const item = Array.from(e.clipboardData.items).find((i) =>
      i.type.startsWith("image/"),
    );
    if (item) {
      const f = item.getAsFile();
      if (f) setFile(f);
    }
  };

  const canSubmit = !!(text.trim() || file);
  const shortcutLabel = isMac() ? "⌘K" : "Ctrl K";

  return (
    <div
      className="w-full"
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
      data-testid="search-bar"
    >
      <motion.div
        layout
        className={`group relative rounded-2xl border bg-card transition-all duration-300 ${
          dragOver
            ? "border-accent shadow-[0_0_0_4px_rgba(184,92,60,0.12),0_18px_50px_-18px_rgba(43,42,40,0.20)]"
            : focused
              ? "border-foreground/25 shadow-[0_0_0_4px_rgba(43,42,40,0.05),0_22px_60px_-22px_rgba(43,42,40,0.28)]"
              : "border-card-border shadow-[0_1px_0_rgba(255,255,255,0.6)_inset,0_12px_40px_-22px_rgba(43,42,40,0.18)]"
        }`}
      >
        {/* Subtle inner highlight */}
        <div className="pointer-events-none absolute inset-0 rounded-2xl bg-gradient-to-b from-white/40 to-transparent" />

        <div className="relative flex items-stretch gap-3 px-4 py-3 sm:px-5 sm:py-4">
          <button
            type="button"
            aria-label="Attach image"
            onClick={() => fileInputRef.current?.click()}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-border text-muted-foreground transition-all hover:scale-105 hover:bg-muted hover:text-foreground active:scale-95"
            data-testid="button-attach"
          >
            <ImageIcon className="h-4 w-4" />
          </button>

          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) setFile(f);
              e.target.value = "";
            }}
          />

          <div className="relative min-w-0 flex-1">
            <input
              ref={inputRef}
              type="text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
                if (e.key === "Escape") {
                  setText("");
                  inputRef.current?.blur();
                }
              }}
              onPaste={handlePaste}
              placeholder=""
              className="peer relative z-10 w-full bg-transparent text-base sm:text-lg font-serif font-light tracking-tight text-foreground outline-none"
              data-testid="input-search"
            />
            {/* Animated placeholder */}
            <AnimatePresence mode="wait">
              {!text && (
                <motion.span
                  key={file ? "with-file" : `ph-${placeholderIdx}`}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  transition={{ duration: 0.35 }}
                  className="pointer-events-none absolute inset-0 flex items-center text-base sm:text-lg font-serif font-light tracking-tight text-muted-foreground/60"
                >
                  {file
                    ? "Describe what to refine — color, material, mood…"
                    : PLACEHOLDERS[placeholderIdx]}
                </motion.span>
              )}
            </AnimatePresence>
          </div>

          {/* Keyboard hint */}
          <div className="hidden items-center gap-1 self-center sm:flex">
            <AnimatePresence mode="wait">
              {focused ? (
                <motion.kbd
                  key="esc"
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.9 }}
                  className="rounded-md border border-border bg-secondary px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground"
                >
                  Esc
                </motion.kbd>
              ) : (
                <motion.kbd
                  key="cmdk"
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.9 }}
                  className="rounded-md border border-border bg-secondary px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground"
                >
                  {shortcutLabel}
                </motion.kbd>
              )}
            </AnimatePresence>
          </div>

          <button
            type="button"
            onClick={submit}
            disabled={isSearching || !canSubmit}
            className="group/btn relative flex h-10 shrink-0 items-center gap-2 overflow-hidden rounded-full bg-foreground px-5 text-sm font-medium text-background transition-all hover:bg-foreground/90 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40"
            data-testid="button-search"
          >
            <AnimatePresence mode="wait" initial={false}>
              {isSearching ? (
                <motion.span
                  key="loading"
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6 }}
                  className="flex items-center gap-2"
                >
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span className="hidden sm:inline">Searching</span>
                </motion.span>
              ) : (
                <motion.span
                  key="ready"
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6 }}
                  className="flex items-center gap-2"
                >
                  <Search className="h-4 w-4" />
                  <span className="hidden sm:inline">Find</span>
                  <CornerDownLeft className="hidden h-3 w-3 opacity-60 sm:inline" />
                </motion.span>
              )}
            </AnimatePresence>
          </button>
        </div>

        <AnimatePresence>
          {preview && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className="relative overflow-hidden border-t border-card-border"
            >
              <div className="flex items-center gap-4 px-4 py-3 sm:px-5">
                <div className="relative">
                  <img
                    src={preview}
                    alt="Reference"
                    className="h-16 w-16 rounded-md object-cover ring-1 ring-border"
                  />
                  <button
                    type="button"
                    aria-label="Remove image"
                    onClick={() => setFile(null)}
                    className="absolute -right-1.5 -top-1.5 rounded-full bg-foreground p-0.5 text-background shadow-md transition hover:bg-foreground/80 hover:scale-110"
                    data-testid="button-remove-image"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="mb-1.5 flex items-baseline justify-between">
                    <span className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                      {text.trim() ? "Blend" : "Visual reference"}
                    </span>
                    {text.trim() && (
                      <span className="font-mono text-[11px] text-muted-foreground">
                        text {Math.round(alpha * 100)}% · image{" "}
                        {Math.round((1 - alpha) * 100)}%
                      </span>
                    )}
                  </div>
                  {text.trim() ? (
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.05}
                      value={alpha}
                      onChange={(e) => setAlpha(parseFloat(e.target.value))}
                      className="w-full accent-accent"
                      data-testid="slider-alpha"
                    />
                  ) : (
                    <p className="truncate text-sm text-muted-foreground">
                      Add words above to refine — color, fit, mood.
                    </p>
                  )}
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>

      <div className="mt-5 flex flex-wrap items-center gap-2">
        <span className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
          Try
        </span>
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => {
              setText(s);
              onSearch({ kind: "text", text: s });
            }}
            className="group/sug flex items-center gap-1 rounded-full border border-border bg-card/60 px-3 py-1 text-xs text-muted-foreground backdrop-blur-sm transition-all duration-200 hover:-translate-y-0.5 hover:border-foreground/30 hover:bg-card hover:text-foreground hover:shadow-sm"
            data-testid={`suggestion-${s.split(",")[0].replace(/\s+/g, "-")}`}
          >
            {s}
            <span className="inline-block w-0 -translate-x-1 overflow-hidden opacity-0 transition-all duration-200 group-hover/sug:w-3 group-hover/sug:translate-x-0 group-hover/sug:opacity-100">
              →
            </span>
          </button>
        ))}
      </div>
    </div>
  );
});
