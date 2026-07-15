import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Virtuoso } from "react-virtuoso";

/** Card footprint — must match the BookCard cover width + the grid gap used
 * throughout the library so virtualized rows line up with the rest of the UI. */
const CARD_WIDTH = 160;
const GAP = 20;

/** Columns that fit in `width` px, mirroring the CSS
 * `grid-cols-[repeat(auto-fill,160px)]` the non-virtualized views use.
 * Exported for testing. */
export function calcColumns(width: number): number {
  return Math.max(1, Math.floor((width + GAP) / (CARD_WIDTH + GAP)));
}

/** Chunk a flat list into rows of `columns`. Exported for testing. */
export function chunkRows<T>(items: T[], columns: number): T[][] {
  if (columns < 1) return [items];
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += columns) {
    rows.push(items.slice(i, i + columns));
  }
  return rows;
}

interface VirtualizedBookGridProps<T> {
  items: T[];
  /** Render a single card. `index` is the item's global index in `items`. */
  renderItem: (index: number, item: T) => ReactNode;
  /** Stable key for an item. */
  itemKey: (item: T) => string;
  /** Content rendered above the grid (carousels, section headers). Scrolls
   * with the list. */
  header?: ReactNode;
  /** The scrollable ancestor. Virtuoso virtualizes within it instead of
   * creating its own scroller, so the page keeps one scrollbar. */
  scrollParent: HTMLElement | null;
}

/**
 * Windowed book grid: only the rows near the viewport are mounted, so the DOM
 * stays small regardless of library size. Rows are chunked from a flat list at
 * a column count derived from the scroll parent's width; `Virtuoso` measures
 * each row, so cards may keep their natural (variable) height.
 */
export default function VirtualizedBookGrid<T>({
  items,
  renderItem,
  itemKey,
  header,
  scrollParent,
}: VirtualizedBookGridProps<T>) {
  const [columns, setColumns] = useState(1);

  useEffect(() => {
    if (!scrollParent) return;
    const measure = () => {
      const style = getComputedStyle(scrollParent);
      const padX = parseFloat(style.paddingLeft || "0") + parseFloat(style.paddingRight || "0");
      setColumns(calcColumns(scrollParent.clientWidth - padX));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(scrollParent);
    return () => observer.disconnect();
  }, [scrollParent]);

  const rows = useMemo(() => chunkRows(items, columns), [items, columns]);

  // Until the scroll parent is known we can't virtualize; render nothing
  // (the parent mounts it on the next tick via a ref-capturing effect).
  if (!scrollParent) return null;

  return (
    <Virtuoso
      customScrollParent={scrollParent}
      data={rows}
      components={header ? { Header: () => <>{header}</> } : undefined}
      computeItemKey={(_index, row) => row.map(itemKey).join("|")}
      itemContent={(rowIndex, row) => (
        <div style={{ display: "flex", justifyContent: "flex-start", gap: GAP, paddingBottom: GAP }}>
          {row.map((item, colIndex) => (
            <div key={itemKey(item)} style={{ width: CARD_WIDTH }}>
              {renderItem(rowIndex * columns + colIndex, item)}
            </div>
          ))}
        </div>
      )}
    />
  );
}
