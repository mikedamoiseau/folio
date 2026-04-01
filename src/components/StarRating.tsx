import { useState, useRef } from "react";

interface StarRatingProps {
  value: number;
  onChange?: (value: number | null) => void;
  size?: "sm" | "md";
}

export default function StarRating({ value, onChange, size = "md" }: StarRatingProps) {
  const [hovered, setHovered] = useState(0);
  const [focused, setFocused] = useState(0);
  const interactive = !!onChange;
  const display = hovered || focused || value;
  const starSize = size === "sm" ? "w-3.5 h-3.5" : "w-5 h-5";
  const starRefs = useRef<(HTMLButtonElement | null)[]>([]);

  function handleKeyDown(e: React.KeyboardEvent, star: number) {
    if (!interactive) return;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      const next = Math.min(star + 1, 5);
      starRefs.current[next - 1]?.focus();
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      const prev = Math.max(star - 1, 1);
      starRefs.current[prev - 1]?.focus();
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onChange?.(star === value ? null : star);
    }
  }

  return (
    <div
      className="inline-flex items-center gap-0.5"
      role="group"
      aria-label={`Rating: ${value || 0} out of 5 stars`}
      onMouseLeave={() => interactive && setHovered(0)}
    >
      {[1, 2, 3, 4, 5].map((star) => (
        <button
          type="button"
          key={star}
          ref={(el) => { starRefs.current[star - 1] = el; }}
          disabled={!interactive}
          tabIndex={interactive ? (star === (value || 1) ? 0 : -1) : -1}
          onClick={() => onChange?.(star === value ? null : star)}
          onMouseEnter={() => interactive && setHovered(star)}
          onFocus={() => interactive && setFocused(star)}
          onBlur={() => setFocused(0)}
          onKeyDown={(e) => handleKeyDown(e, star)}
          className={`${starSize} ${interactive ? "cursor-pointer hover:scale-110" : "cursor-default"} transition-transform disabled:opacity-100 focus-visible:ring-2 focus-visible:ring-accent focus-visible:rounded-sm`}
          aria-label={`${star} star${star > 1 ? "s" : ""}`}
          aria-pressed={interactive ? star <= value : undefined}
        >
          <svg viewBox="0 0 20 20" fill={star <= display ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.5"
            className={star <= display ? "text-amber-400" : "text-ink-muted/30"}
          >
            <path d="M10 1.5l2.47 5.01 5.53.8-4 3.9.94 5.49L10 14.26 5.06 16.7 6 11.21l-4-3.9 5.53-.8L10 1.5z" />
          </svg>
        </button>
      ))}
      {interactive && value > 0 && (
        <button
          type="button"
          onClick={() => onChange?.(null)}
          className="ml-1 text-[10px] text-ink-muted/50 hover:text-ink-muted transition-colors"
          aria-label="Clear rating"
          title="Clear rating"
        >
          ✕
        </button>
      )}
    </div>
  );
}
