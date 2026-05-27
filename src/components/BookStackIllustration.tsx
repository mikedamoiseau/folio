export default function BookStackIllustration() {
  return (
    <div className="relative w-28 h-28 flex items-end justify-center">
      {/* Back book */}
      <div
        className="absolute bottom-0 left-3 w-16 h-20 rounded-sm bg-warm-subtle border border-warm-border shadow-sm rotate-[-8deg] origin-bottom"
        style={{ animation: "empty-book-in 0.4s cubic-bezier(0.22, 1, 0.36, 1) 0.1s both" }}
      />
      {/* Middle book */}
      <div
        className="absolute bottom-0 left-6 w-16 h-[72px] rounded-sm bg-warm-border shadow-sm rotate-[3deg] origin-bottom"
        style={{ animation: "empty-book-in 0.4s cubic-bezier(0.22, 1, 0.36, 1) 0.25s both" }}
      />
      {/* Front book */}
      <div
        className="relative w-16 h-[84px] rounded-sm bg-accent-light border border-accent/30 shadow-md flex flex-col items-center justify-center gap-2"
        style={{ animation: "empty-book-in 0.4s cubic-bezier(0.22, 1, 0.36, 1) 0.4s both" }}
      >
        <div className="w-8 h-px bg-accent/40 rounded" />
        <div className="w-6 h-px bg-accent/30 rounded" />
        <div className="w-8 h-px bg-accent/40 rounded" />
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" className="text-accent mt-1">
          <path
            d="M4 19.5v-15A2.5 2.5 0 016.5 2H20v20H6.5a2.5 2.5 0 010-5H20"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
    </div>
  );
}
