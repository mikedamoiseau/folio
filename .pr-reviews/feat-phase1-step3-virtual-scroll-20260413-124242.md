# PR Review: feat-phase1-step3-virtual-scroll
**Date:** 2026-04-13 12:42
**Mode:** review + fix (3-agent voting)
**Agents:** Codex (reviewer) + Gemini (reviewer) + Claude (implementer)
**Base:** main
**Diff lines:** 486
**Approval rule:** 2/3 majority vote

---


## [Codex — Reviewer] Round 1

NEEDS_FIX: the new virtualized library grid has a broken height contract and can reuse `BookCard` state for the wrong book.

1. **File**: [src/screens/Library.tsx](/Users/mike/Documents/www/folio/src/screens/Library.tsx:446), [src/screens/Library.tsx](/Users/mike/Documents/www/folio/src/screens/Library.tsx:780), [src/screens/Library.tsx](/Users/mike/Documents/www/folio/src/screens/Library.tsx:1066), [src/components/VirtualBookGrid.tsx](/Users/mike/Documents/www/folio/src/components/VirtualBookGrid.tsx:97)  
   **What** can go wrong: the virtualized grid viewport does not size to the available library pane; it stabilizes around the seeded `600px` height instead. On taller windows this leaves a short inner scroller with unused space below; on shorter windows it creates an oversized nested scroll area.  
   **Why** the code is vulnerable to this: `gridHeight` is measured from `gridAreaRef.current.clientHeight`, but `gridAreaRef` is inside a non-flex parent (`overflow-y-auto p-6`) and has no explicit height of its own. Its height is therefore derived from its child, while the child `Grid` is itself rendered with `style={{ height }}` using the current `gridHeight` state. That is a circular measurement seeded by `useState(600)`, not a measurement of available space.  
   **Impact** if it happens: the main library view gets incorrect scrolling behavior and inconsistent visible rows depending on window size, which defeats the intended virtualization behavior and is a user-visible regression.  
   **Fix** recommendation: make the content area that contains the grid a real flex column with a child that owns the remaining height, or measure from a container with an explicit height contract. Do not derive the viewport height from the auto-sized wrapper around the grid itself.  
   **Severity**: BLOCKING  
   **Fixable**: YES

2. **File**: [src/screens/Library.tsx](/Users/mike/Documents/www/folio/src/screens/Library.tsx:1070), [src/components/VirtualBookGrid.tsx](/Users/mike/Documents/www/folio/src/components/VirtualBookGrid.tsx:44), [src/components/VirtualBookGrid.tsx](/Users/mike/Documents/www/folio/src/components/VirtualBookGrid.tsx:55), [src/components/BookCard.tsx](/Users/mike/Documents/www/folio/src/components/BookCard.tsx:54), [src/components/BookCard.tsx](/Users/mike/Documents/www/folio/src/components/BookCard.tsx:223)  
   **What** can go wrong: state from one book card can appear on a different book when cells are recycled. A concrete case already exists: `BookCard` keeps local `confirming` state for the delete modal, so after scrolling/filtering/sorting, the recycled cell can render another book while preserving the previous card’s modal state.  
   **Why** the code is vulnerable to this: `react-window` reuses cell positions, and `renderItem(index)` returns a stateful `BookCard` subtree without an item-identity key. React therefore reconciles by position, not by `book.id`, so the `BookCard` instance is reused across different books as the virtual cell’s `index` changes.  
   **Impact** if it happens: destructive actions and UI state can be shown against the wrong book, which is a correctness problem and can lead to deleting or acting on the wrong item.  
   **Fix** recommendation: key the rendered subtree by `book.id` so React remounts stateful card content when a cell starts showing a different book. If you keep local state inside virtualized items, identity must be tied to the item, not the slot.  
   **Severity**: BLOCKING  
   **Fixable**: YES

3. **File**: [src/components/VirtualBookGrid.tsx](/Users/mike/Documents/www/folio/src/components/VirtualBookGrid.tsx:5), [src/components/VirtualBookGrid.tsx](/Users/mike/Documents/www/folio/src/components/VirtualBookGrid.tsx:17), [src/components/VirtualBookGrid.tsx](/Users/mike/Documents/www/folio/src/components/VirtualBookGrid.tsx:52), [src/components/BookCard.tsx](/Users/mike/Documents/www/folio/src/components/BookCard.tsx:242), [src/components/BookCard.tsx](/Users/mike/Documents/www/folio/src/components/BookCard.tsx:247)  
   **What** can go wrong: card content is clipped for books that render extra metadata, such as ratings and multiple metadata pills.  
   **Why** the code is vulnerable to this: the grid hard-codes `CARD_HEIGHT = 310`, but `BookCard` is not fixed-height content. It conditionally renders rating UI and a wrapping metadata-pill block, while the root card is forced to `h-full` with `overflow-hidden`. The previous non-virtual grid allowed the card height to grow naturally; the new grid forces a single fixed row height.  
   **Impact** if it happens: users lose visible metadata/progress content on some books, and cards can look truncated or inconsistent.  
   **Fix** recommendation: either use a row height that safely covers the maximum supported card content and add a regression test for the tallest card variant, or switch to a virtualization approach that supports measured/dynamic item heights.  
   **Severity**: SUGGESTION  
   **Fixable**: NO

---

## [Gemini — Reviewer] Round 1

NEEDS_FIX: `react-window`'s `Grid` component is used with incorrect props (`cellComponent`, `cellProps`), causing a runtime error or rendering failure.

**Detailed Findings:**

1.  **File**: `src/components/VirtualBookGrid.tsx`
    **Line Number(s)**: 34-45 (Cell component signature), 75-78 (Grid usage)
    **What can go wrong**: The `VirtualBookGrid` component attempts to render `react-window`'s `Grid` using `cellComponent={Cell}` and `cellProps={...}`. `react-window`'s `Grid` component does not expose `cellComponent` or `cellProps`. Instead, it expects the `Cell` component to be passed as `children` and any additional data to be passed via the `itemData` prop. The `Cell` component's current prop signature also incorrectly expects an `ariaAttributes` prop that `react-window` does not pass.
    **Why the code is vulnerable to this**: This is a fundamental misunderstanding and incorrect usage of the `react-window` library's `Grid` API. Passing non-existent props will either lead to runtime errors (if React complains about unknown props or if the `Cell` component tries to destructure undefined props) or simply prevent the virtualization from working as intended, resulting in a blank or improperly rendered grid.
    **Impact**: The virtualized book grid will not function correctly. Users will likely see a blank area where the books should be, or the application might crash when trying to render the `Library` screen in a non-series sorted view. This makes a core feature of the application unusable.
    **Fix recommendation**:
        1.  Modify the `VirtualBookGrid` component (`src/components/VirtualBookGrid.tsx`) to pass the `Cell` component directly as `children` to the `Grid` component (e.g., `<Grid>{Cell}</Grid>`).
        2.  Pass the `items`, `renderItem`, `columnCount`, and `paddingLeft` as a single object to the `Grid`'s `itemData` prop.
        3.  Refactor the `Cell` component's signature (`src/components/VirtualBookGrid.tsx`) to accept a `data` prop, from which it will destructure `items`, `renderItem`, `columnCount`, and `paddingLeft`.
        4.  Remove the `ariaAttributes` prop from the `Cell` component's signature, as `react-window` typically handles these attributes internally or expects them to be applied by the `renderItem` function if they pertain to the content *within* the cell.
    **Severity**: BLOCKING
    **Fixable**: NO (Requires refactoring and understanding of `react-window` API).

---

