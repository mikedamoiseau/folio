# UX Conventions

Living conventions for the Folio frontend. Each section is enforced by a
scanner test in `src/lib/uxConsistency.audit.test.ts` where possible, so drift
fails CI rather than waiting on review.

## Spacing — 4px grid with a 2px sub-grid for compact components

- **Layout spacing** uses Tailwind's standard scale (`p-4`, `gap-3`, `mb-8`),
  which maps to 4px multiples. This is the default — reach for it first.
- **Compact components** (icon buttons, list rows, badges, search results) may
  use Tailwind's half-step classes (`p-1.5`, `py-1.5`, `mt-0.5`, `gap-1.5`).
  These resolve to 2px / 6px / 10px and form a deliberate 2px sub-grid for
  fine-grained nudges.
- **Arbitrary `[Npx]` / `[Nrem]` spacing values are banned unless the value is
  a 4px multiple.** A scanner test enforces this — `p-[7px]`, `mt-[13px]`, and
  similar one-offs fail CI. CSS variables and `calc()` expressions are
  allowed.

If you find yourself reaching for `p-[5px]`, the answer is almost always `p-1`
(4px) or `p-1.5` (6px). If you reach for `mt-[15px]`, the answer is `mt-4`
(16px).
