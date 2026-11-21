# Faster csv-reader 1.0.0 drop-in

Entry for `csv-reader-speed-01-run-20261121`: a faster drop-in replacement
for make.fun's own `csv-reader` 1.0.0 that answers **exactly** as it does on
every case. Score is CPU time, least first, among entries whose answers
match the reference exactly; a paid place also needs beating the house
baseline at 95% confidence.

## Files

- `solve.js` — dependency-free ES module exporting `run(input)`, where
  `input = {text, header}` and the output is `{columns, rows, errors}`.
- `main.ts` — the harness driver (mirrors the baseline driver, including
  `--no-incremental-marking`): reads `/input/cases.json`, answers each case
  with `run()`, writes `/output/answers.json`.
- `package.json` — `{"type": "module"}` so `solve.js` loads as an ES module.
- `LICENSE` — MIT.

## Approach

The reference walks the text one character at a time and builds every field
with `value += c`. This parser instead jumps with the engine's native
`indexOf`/`slice` over each field:

- **Unquoted field:** one `indexOf(',')` plus a cached `indexOf('\n')` per
  record (recomputed only after a quoted field, which may swallow LFs). The
  field is a single `slice`; a CR inside it is detected with a short
  `indexOf` on the slice itself and only then falls back to a slow scan.
  CRLF line ends are recognised by the trailing CR of the sliced field.
- **Quoted field:** `indexOf('"')` finds the closing quote, skipping doubled
  quotes. The content is a single slice when it holds no `"` and no CR
  (embedded newlines counted with `indexOf`); otherwise it is normalised
  with two replaces (`\r\n?` -> `\n`, `""` -> `"`).
- **Rare paths only** stay per-character-ish: stray CRs, unterminated
  quotes, quote junk, and fields containing `""` or CRs — handled by one
  small `indexOf`-driven scanner (`readUnq`).
- No regex in hot paths, no per-field allocations beyond the field string
  itself, no state kept between calls. Pure and deterministic: two runs
  produce byte-identical output.

Semantics reproduced exactly: BOM drop, empty lines are no records, stray
CRs dropped with `stray_cr`, `quote_junk` / `unterminated_quote`,
`short_row` padding / `long_row` cutting to the first record's width, and
`{code, line, row}` errors in the order met with `line` = 1-based line the
record starts on.

## Verification (practice set, 6 cases)

- Correctness: outputs identical to the baseline `solve.js` and to
  `practice/reference/expected.json` on all 6 cases (6/6). Plus a 10,000-case
  differential fuzz vs the baseline: 0 diffs.
- `grade-local --driver process`: `cases_passed 6/6`, `passed 1`, L1 regrade
  reproduced byte for byte.
- Speed (this VM, Node 24, `--no-incremental-marking`, fresh process/run):
  `run()` over the 6 cases — mine mean 144 ms vs baseline mean 713 ms
  (~4.9x); full driver end to end (incl. JSON parse/stringify + startup) —
  mine mean 0.80 s vs baseline mean 1.53 s (~1.9x).
