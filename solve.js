// Fast drop-in for csv-reader 1.0.0 (make.fun's own CSV reader).
//
// Same answers, byte for byte, on every input — same broken-row policy:
// U+FEFF dropped; records end at LF/CRLF; empty lines are no records; a CR
// outside quotes not followed by LF is dropped (stray_cr); a field opening
// with a quote runs to the next non-doubled quote ("" = one quote, CRLF/lone
// CR inside read as LF), junk after the closing quote is appended
// (quote_junk), an unterminated quote is a literal and the rest is re-read
// unquoted (unterminated_quote); quotes inside unquoted fields are literal;
// no trimming/conversion; rows padded (short_row) or cut (long_row) to the
// first record's width; errors {code, line, row} in the order met.
//
// Speed: the reference walks the text one character at a time, building
// every field with `value += c`. This parser instead jumps with the engine's
// native indexOf/slice over each field:
//  - unquoted field: one indexOf(',') plus a cached indexOf('\n') per
//    record (recomputed only after a quoted field, which may swallow LFs);
//    the field is a single slice; a CR inside it is detected with a short
//    indexOf on the slice itself and only then falls back to a slow scan.
//  - quoted field: indexOf('"') to find the closing quote, skipping doubled
//    quotes; the content is a single slice when it holds no '"' and no CR
//    (newlines counted with indexOf), otherwise normalised with two
//    replaces. Junk after the closing quote reuses the unquoted scanner.
//  - the only per-character work left is the rare paths: stray CRs,
//    unterminated quotes, quote junk, and fields containing "" or CRs.
// No regex in hot paths, no per-field allocations beyond the field string
// itself, no state kept between calls. Pure and deterministic.

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let line = 1;
  // Index of the next '\n' at or after pos, -1 = none left, -2 = unknown.
  let nl = -2;

  // The record being read: the line it starts on and its index in rows
  // (null for the header). Read by the slow scanner below.
  let recordLine = 1;
  let recordRow = null;

  function strayCr() {
    errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
  }

  // Slow unquoted scan from p, starting from value `val` ('' normally, '"'
  // for an unterminated quote, the quoted value for quote junk). Handles
  // stray CRs. Returns {value, ended, added}; updates pos/line. Only used
  // on paths the fast inline scan cannot take.
  function readUnq(val, p) {
    let added = 0;
    for (;;) {
      if (p >= n) {
        pos = p;
        return { value: val, ended: END, added };
      }
      const c = text.indexOf(',', p);
      const lf = text.indexOf('\n', p);
      const cr = text.indexOf('\r', p);
      let m = -1;
      let kind = 0; // 0 comma, 1 LF, 2 CR
      if (c !== -1) {
        m = c;
        kind = 0;
      }
      if (lf !== -1 && (m === -1 || lf < m)) {
        m = lf;
        kind = 1;
      }
      if (cr !== -1 && (m === -1 || cr < m)) {
        m = cr;
        kind = 2;
      }
      if (m === -1) {
        // No delimiter left and no CR left: the rest is the field.
        val += text.slice(p);
        added += n - p;
        pos = n;
        return { value: val, ended: END, added };
      }
      if (kind === 2) {
        if (text.charCodeAt(m + 1) === 10) {
          val += text.slice(p, m);
          added += m - p;
          pos = m + 2;
          line += 1;
          return { value: val, ended: LINE_BREAK, added };
        }
        val += text.slice(p, m);
        added += m - p;
        strayCr();
        p = m + 1;
        continue;
      }
      val += text.slice(p, m);
      added += m - p;
      if (kind === 0) {
        pos = m + 1;
        return { value: val, ended: COMMA, added };
      }
      pos = m + 1;
      line += 1;
      return { value: val, ended: LINE_BREAK, added };
    }
  }

  // Count '\n' in s with native indexOf (s is a quoted field's content).
  function countLf(s) {
    let cnt = 0;
    let i = s.indexOf('\n');
    while (i !== -1) {
      cnt += 1;
      i = s.indexOf('\n', i + 1);
    }
    return cnt;
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    nl = -2;
    const fields = [];
    let quoted = false;
    let ended;

    for (;;) {
      quoted = text.charCodeAt(pos) === 34;
      let value;
      if (quoted) {
        const open = pos;
        let q = text.indexOf('"', pos + 1);
        while (q !== -1 && text.charCodeAt(q + 1) === 34) q = text.indexOf('"', q + 2);
        if (q === -1) {
          // Unterminated: the quote is literal, re-read as unquoted.
          errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
          const r = readUnq('"', open + 1);
          value = r.value;
          ended = r.ended;
          nl = -2;
        } else {
          const raw = text.slice(open + 1, q);
          if (raw.indexOf('"') === -1 && raw.indexOf('\r') === -1) {
            value = raw;
            const k = countLf(raw);
            if (k) line += k;
          } else {
            // "" -> ", CRLF/lone CR -> LF; line += number of breaks.
            value = raw.replace(/\r\n?/g, '\n').replace(/""/g, '"');
            const k = countLf(value);
            if (k) line += k;
          }
          pos = q + 1;
          nl = -2;
          if (pos >= n) {
            ended = END;
          } else {
            const cc = text.charCodeAt(pos);
            if (cc === 44) {
              pos += 1;
              ended = COMMA;
            } else if (cc === 10) {
              pos += 1;
              line += 1;
              ended = LINE_BREAK;
            } else if (cc === 13 && text.charCodeAt(pos + 1) === 10) {
              pos += 2;
              line += 1;
              ended = LINE_BREAK;
            } else {
              // Junk after the closing quote, appended as it stands.
              const r = readUnq(value, pos);
              if (r.added > 0) {
                errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
              }
              value = r.value;
              ended = r.ended;
            }
          }
        }
      } else {
        // Unquoted field: comma vs line break, decided by native search.
        if (nl === -2 || nl < pos) nl = text.indexOf('\n', pos);
        const cIdx = text.indexOf(',', pos);
        if (cIdx !== -1 && (nl === -1 || cIdx < nl)) {
          value = text.slice(pos, cIdx);
          if (value.indexOf('\r') !== -1) {
            const r = readUnq('', pos);
            value = r.value;
            ended = r.ended;
          } else {
            pos = cIdx + 1;
            ended = COMMA;
          }
        } else if (nl !== -1) {
          value = text.slice(pos, nl);
          if (value.charCodeAt(value.length - 1) === 13) {
            // CRLF line break: drop the trailing CR, but a CR may still
            // hide earlier in the field (stray_cr) — check before keeping.
            value = value.slice(0, -1);
          }
          if (value.indexOf('\r') !== -1) {
            const r = readUnq('', pos);
            value = r.value;
            ended = r.ended;
          } else {
            pos = nl + 1;
            line += 1;
            ended = LINE_BREAK;
          }
        } else {
          value = text.slice(pos);
          if (value.indexOf('\r') !== -1) {
            const r = readUnq('', pos);
            value = r.value;
            ended = r.ended;
          } else {
            pos = n;
            ended = END;
          }
        }
      }
      fields.push(value);
      if (ended !== COMMA) break;
    }

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
