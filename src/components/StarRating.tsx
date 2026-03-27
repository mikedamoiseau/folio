import { useState } from "react";

interface StarRatingProps {
  value: number;
  onChange?: (value: number) => void;
  size?: "sm" | "md";
}

export default function StarRating({ value, onChange, size = "md" }: StarRatingProps) {
  const [hovered, setHovered] = useState(0);
  const interactive = !!onChange;
  const display = hovered || value;
  const starSize = size === "sm" ? "w-3.5 h-3.5" : "w-5 h-5";

  return (
    <div
      className="inline-flex gap-0.5"
      onMouseLeave={() => interactive && setHovered(0)}
    >
      {[1, 2, 3, 4, 5].map((star) => (
        <button
          type="button"
          key={star}
          disabled={!interactive}
          onClick={() => onChange?.(star)}
          onMouseEnter={() => interactive && setHovered(star)}
          className={`${starSize} ${interactive ? "cursor-pointer hover:scale-110" : "cursor-default"} transition-transform disabled:opacity-100`}
        >
          <svg viewBox="0 0 20 20" fill={star <= display ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.5"
            className={star <= display ? "text-amber-400" : "text-ink-muted/30"}
          >
            <path d="M10 1.5l2.47 5.01 5.53.8-4 3.9.94 5.49L10 14.26 5.06 16.7 6 11.21l-4-3.9 5.53-.8L10 1.5z" />
          </svg>
        </button>
      ))}
    </div>
  );
}
