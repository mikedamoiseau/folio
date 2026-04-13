import React, { useRef, useEffect, useState, useCallback, type CSSProperties, type ReactElement } from "react";
import { Grid } from "react-window";

const CARD_WIDTH = 160;
const CARD_HEIGHT = 310; // 2:3 cover (240px) + info area (~70px)
const GAP = 20;

/** Pure layout calculation — exported for testing. */
export function calcGridLayout(containerWidth: number) {
  const columnCount = Math.max(1, Math.floor((containerWidth + GAP) / (CARD_WIDTH + GAP)));
  const totalGridWidth = columnCount * (CARD_WIDTH + GAP) - GAP;
  const paddingLeft = Math.max(0, Math.floor((containerWidth - totalGridWidth) / 2));

  return {
    columnCount,
    columnWidth: CARD_WIDTH + GAP,
    rowHeight: CARD_HEIGHT + GAP,
    paddingLeft,
    rowCount: (itemCount: number) => Math.ceil(itemCount / columnCount),
  };
}

interface CellProps {
  items: unknown[];
  renderItem: (index: number) => React.ReactNode;
  columnCount: number;
  paddingLeft: number;
}

function Cell({
  columnIndex,
  rowIndex,
  style,
  ariaAttributes,
  items,
  renderItem,
  columnCount,
  paddingLeft,
}: {
  columnIndex: number;
  rowIndex: number;
  style: CSSProperties;
  ariaAttributes: { "aria-colindex": number; role: "gridcell" };
} & CellProps): ReactElement | null {
  const index = rowIndex * columnCount + columnIndex;
  if (index >= items.length) return null;
  return (
    <div
      role={ariaAttributes.role}
      aria-colindex={ariaAttributes["aria-colindex"]}
      aria-rowindex={rowIndex + 1}
      style={{
        ...style,
        left: (style.left as number) + paddingLeft,
        width: CARD_WIDTH,
        height: CARD_HEIGHT,
      }}
    >
      {renderItem(index)}
    </div>
  );
}

interface VirtualBookGridProps {
  items: unknown[];
  renderItem: (index: number) => React.ReactNode;
}

export default function VirtualBookGrid({ items, renderItem }: VirtualBookGridProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);

  const updateWidth = useCallback(() => {
    if (containerRef.current) {
      setContainerWidth(containerRef.current.clientWidth);
    }
  }, []);

  useEffect(() => {
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    if (containerRef.current) observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [updateWidth]);

  const layout = calcGridLayout(containerWidth || 1000);
  const rowCount = layout.rowCount(items.length);

  return (
    <div ref={containerRef} className="w-full h-full">
      {containerWidth > 0 && (
        <Grid
          cellComponent={Cell}
          cellProps={{ items, renderItem, columnCount: layout.columnCount, paddingLeft: layout.paddingLeft }}
          columnCount={layout.columnCount}
          columnWidth={layout.columnWidth}
          rowCount={rowCount}
          rowHeight={layout.rowHeight}
          style={{ overflowX: "hidden" }}
          className="h-full"
        />
      )}
    </div>
  );
}
