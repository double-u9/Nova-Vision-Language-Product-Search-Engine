import { useCountUp } from "@/lib/hooks";

interface Props {
  value: number;
  className?: string;
  suffix?: string;
  durationMs?: number;
}

export function AnimatedCounter({
  value,
  className = "",
  suffix,
  durationMs = 1600,
}: Props) {
  const v = useCountUp(value, durationMs);
  return (
    <span className={`tabular-nums ${className}`}>
      {v.toLocaleString()}
      {suffix}
    </span>
  );
}
