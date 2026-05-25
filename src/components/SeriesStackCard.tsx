import { useTranslation } from "react-i18next";

interface SeriesStackCover {
  id: string;
  coverSrc: string | null;
}

interface SeriesStackCardProps {
  seriesName: string;
  bookCount: number;
  covers: SeriesStackCover[];
  onClick: () => void;
}

export default function SeriesStackCard({
  seriesName,
  bookCount,
  covers,
  onClick,
}: SeriesStackCardProps) {
  const { t } = useTranslation();
  const backCards = covers.slice(1, 3);

  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full text-left group cursor-pointer"
      title={seriesName}
    >
      <div className="relative" style={{ padding: "8px 8px 0 0" }}>
        {backCards.map((book, i) => {
          const offset = (i + 1) * 4;
          return (
            <div
              key={book.id}
              className="absolute aspect-[2/3] rounded-lg overflow-hidden bg-warm-subtle"
              style={{
                top: offset,
                left: offset,
                width: "calc(100% - 8px)",
                opacity: i === 0 ? 0.5 : 0.3,
                zIndex: 0,
              }}
            >
              {book.coverSrc && (
                <img
                  src={book.coverSrc}
                  alt=""
                  loading="lazy"
                  className="w-full h-full object-cover"
                />
              )}
            </div>
          );
        })}
        <div
          className="relative aspect-[2/3] bg-warm-subtle overflow-hidden rounded-lg transition-transform duration-300 group-hover:scale-[1.02]"
          style={{
            zIndex: 2,
            boxShadow: "0 2px 6px rgba(0,0,0,0.15)",
          }}
        >
          {covers[0]?.coverSrc ? (
            <img
              src={covers[0].coverSrc}
              alt={seriesName}
              loading="lazy"
              className="w-full h-full object-cover"
            />
          ) : (
            <div className="flex items-center justify-center w-full h-full">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" className="text-ink-muted/30">
                <path d="M4 19.5A2.5 2.5 0 016.5 17H20" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
          )}
        </div>
      </div>
      <div className="mt-2 px-0.5">
        <p className="text-sm font-medium text-ink truncate" title={seriesName}>
          {seriesName}
        </p>
        <p className="text-xs text-ink-muted">
          {t("seriesView.bookCount", { count: bookCount })}
        </p>
      </div>
    </button>
  );
}
