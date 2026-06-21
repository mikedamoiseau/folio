interface ReaderSkeletonProps {
  /** "full" (default) renders the whole reader chrome; "content" renders only the text placeholder for use inside an existing reader layout. */
  variant?: "full" | "content";
}

function ContentLines() {
  return (
    <div className="flex-1 p-8 flex flex-col gap-3 max-w-3xl mx-auto w-full">
      <div className="w-3/4 h-5 rounded bg-warm-subtle" />
      <div className="w-full h-4 rounded bg-warm-subtle" />
      <div className="w-[90%] h-4 rounded bg-warm-subtle" />
      <div className="w-[85%] h-4 rounded bg-warm-subtle" />
      <div className="w-full h-4 rounded bg-warm-subtle" />
      <div className="w-[70%] h-4 rounded bg-warm-subtle" />
      <div className="w-[95%] h-4 rounded bg-warm-subtle" />
      <div className="w-3/5 h-4 rounded bg-warm-subtle" />
    </div>
  );
}

export default function ReaderSkeleton({ variant = "full" }: ReaderSkeletonProps = {}) {
  if (variant === "content") {
    return (
      <div className="flex-1 flex flex-col animate-pulse" aria-hidden="true">
        <ContentLines />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen bg-paper text-ink animate-pulse">
      {/* Header bar */}
      <div className="shrink-0 h-12 px-4 flex items-center gap-3 border-b border-warm-border bg-surface">
        <div className="w-8 h-8 rounded bg-warm-subtle" />
        <div className="w-48 h-5 rounded bg-warm-subtle" />
      </div>

      {/* Content area */}
      <div className="flex flex-1 min-h-0">
        {/* Sidebar placeholder */}
        <div className="hidden md:flex flex-col w-56 border-r border-warm-border bg-surface p-4 gap-3">
          <div className="w-full h-4 rounded bg-warm-subtle" />
          <div className="w-3/4 h-4 rounded bg-warm-subtle" />
          <div className="w-5/6 h-4 rounded bg-warm-subtle" />
          <div className="w-2/3 h-4 rounded bg-warm-subtle" />
        </div>

        {/* Main content placeholder */}
        <ContentLines />
      </div>
    </div>
  );
}
