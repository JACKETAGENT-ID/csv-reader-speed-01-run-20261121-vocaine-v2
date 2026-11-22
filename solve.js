// Fast drop-in replacement for csv-reader 1.0.0.
//
// Design: two phases over the input text.
//   Phase 1 walks the text once with indexOf jumps and records, for every
//   record, its start offset, its content end offset, the 1-based line it
//   starts on, and whether it needs the slow path (it contains a carriage
//   return anywhere, or a field that opens with a quote). Quote state is
//   tracked while scanning so line breaks inside quoted fields never split
//   a record; a quote that never closes falls back to unquoted scanning
//   from just after the quote, exactly like the reference reader.
//   Phase 2 turns records into fields. Clean records are sliced between
//   commas. Flagged records go through a bounded quirk parser that
//   reproduces every error and oddity of the reference for that record.
//
// No dependencies. run(input) -> {columns, rows, errors}.

const COMMA = 0;
const BREAK = 1;
const EOF_END = 2;

// Count line breaks in text[from, to): each LF counts, each CRLF counts
// once, each lone CR counts once.
function countBreaks(text, from, to) {
  let n = 0;
  let i = text.indexOf('\n', from);
  while (i !== -1 && i < to) {
    n += 1;
    i = text.indexOf('\n', i + 1);
  }
  i = text.indexOf('\r', from);
  while (i !== -1 && i < to) {
    if (text[i + 1] !== '\n') n += 1;
    i = text.indexOf('\r', i + 1);
  }
  return n;
}

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const len = text.length;

  // ---- Phase 1: record boundaries -------------------------------------
  const starts = [];
  const ends = [];
  const lines = [];
  const flags = [];
  let pos = len > 0 && text.charCodeAt(0) === 0xFEFF ? 1 : 0;
  let line = 1;
  // Monotonic caches for the next CR / LF at or after the scan position,
  // so a CR-free or LF-free tail is scanned once, not once per field.
  let nextCr = text.indexOf('\r', pos);
  let nextLf = text.indexOf('\n', pos);
  let nextQuote = text.indexOf('"', pos);

  // Scan one unquoted stretch (a whole field, or the junk after a closing
  // quote) starting at pos. Advances pos past the terminator and returns
  // {ended, hadCr, contentEnd}: contentEnd is the offset where the field's
  // own characters stop (before any terminator).
  function scanUnquoted() {
    let hadCr = false;
    for (;;) {
      if (nextCr !== -1 && nextCr < pos) nextCr = text.indexOf('\r', pos);
      if (nextLf !== -1 && nextLf < pos) nextLf = text.indexOf('\n', pos);
      const nc = text.indexOf(',', pos);
      let idx = -1;
      let kind = -1; // 0 comma, 1 LF, 2 CR
      if (nc !== -1) { idx = nc; kind = 0; }
      if (nextLf !== -1 && (idx === -1 || nextLf < idx)) { idx = nextLf; kind = 1; }
      if (nextCr !== -1 && (idx === -1 || nextCr < idx)) { idx = nextCr; kind = 2; }
      if (idx === -1) {
        pos = len;
        return { ended: EOF_END, hadCr, contentEnd: len };
      }
      if (kind === 0) {
        pos = idx + 1;
        return { ended: COMMA, hadCr, contentEnd: idx };
      }
      if (kind === 1) {
        pos = idx + 1;
        line += 1;
        return { ended: BREAK, hadCr, contentEnd: idx };
      }
      // CR at idx. A CRLF terminator is not an oddity: the record's own
      // characters hold no CR, so it stays on the clean path. Only a
      // lone CR (dropped, stray_cr) flags the record.
      if (text[idx + 1] === '\n') {
        pos = idx + 2;
        line += 1;
        return { ended: BREAK, hadCr, contentEnd: idx };
      }
      hadCr = true;
      pos = idx + 1; // lone CR: dropped, the field goes on
    }
  }

  while (pos < len) {
    // Blank lines (nothing before an LF or a CRLF) are not records.
    while (pos < len) {
      const c = text[pos];
      if (c === '\n') { pos += 1; line += 1; }
      else if (c === '\r' && text[pos + 1] === '\n') { pos += 2; line += 1; }
      else break;
    }
    if (pos >= len) break;

    const recStart = pos;
    const recLine = line;

    // Record fast path: if the rest of this line holds no quote and no
    // CR before its LF (or only the CR of a CRLF ending), the record is
    // clean and ends at that LF — no field scanning needed at all.
    if (nextCr !== -1 && nextCr < pos) nextCr = text.indexOf('\r', pos);
    if (nextLf !== -1 && nextLf < pos) nextLf = text.indexOf('\n', pos);
    if (nextQuote !== -1 && nextQuote < pos) nextQuote = text.indexOf('"', pos);
    if (nextLf !== -1) {
      const lf = nextLf;
      if ((nextQuote === -1 || nextQuote > lf) &&
          (nextCr === -1 || nextCr > lf || nextCr === lf - 1)) {
        starts.push(recStart);
        ends.push(nextCr === lf - 1 ? lf - 1 : lf);
        lines.push(recLine);
        flags.push(false);
        pos = lf + 1;
        line += 1;
        continue;
      }
    } else if (nextQuote === -1 && nextCr === -1) {
      // Final record with no quote, no CR and no LF left: clean to EOF.
      starts.push(recStart);
      ends.push(len);
      lines.push(recLine);
      flags.push(false);
      pos = len;
      continue;
    }

    let flagged = false;
    let contentEnd = len;
    let recordDone = false;

    while (!recordDone) {
      if (text[pos] === '"') {
        flagged = true;
        const open = pos;
        // The closing quote is the next quote that is not doubled.
        let q = text.indexOf('"', open + 1);
        while (q !== -1 && text[q + 1] === '"') q = text.indexOf('"', q + 2);
        if (q === -1) {
          // Never closes: the quote is literal, the rest is re-read
          // as an unquoted field starting just after it.
          pos = open + 1;
          const r = scanUnquoted();
          if (r.hadCr) flagged = true;
          contentEnd = r.contentEnd;
          recordDone = r.ended !== COMMA;
          continue;
        }
        line += countBreaks(text, open + 1, q);
        if (nextCr !== -1 && nextCr <= q) nextCr = text.indexOf('\r', q + 1);
        if (nextLf !== -1 && nextLf <= q) nextLf = text.indexOf('\n', q + 1);
        pos = q + 1;
        // Junk after the closing quote, up to comma / break / end.
        const r = scanUnquoted();
        if (r.hadCr) flagged = true;
        contentEnd = r.contentEnd;
        recordDone = r.ended !== COMMA;
        continue;
      }
      const r = scanUnquoted();
      if (r.hadCr) flagged = true;
      contentEnd = r.contentEnd;
      recordDone = r.ended !== COMMA;
    }

    starts.push(recStart);
    ends.push(contentEnd);
    lines.push(recLine);
    flags.push(flagged);
  }

  // ---- Phase 2: fields -------------------------------------------------
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;
  const n = starts.length;

  for (let ri = 0; ri < n; ri++) {
    const s = starts[ri];
    const e = ends[ri];
    const recLine = lines[ri];
    const recordRow = header && columns === null ? null : rows.length;
    let fields;
    let lastQuoted = false;

    if (!flags[ri]) {
      // Clean record: no lone CR, no quoted field. Native split on the
      // record's slice is the fastest way to cut it into fields.
      fields = text.slice(s, e).split(',');
    } else {
      const parsed = parseFlaggedRecord(text, s, e, recLine, recordRow, errors);
      fields = parsed.fields;
      lastQuoted = parsed.lastQuoted;
    }

    // A line that held only stray CRs leaves one empty unquoted field:
    // it is no record (its errors, already emitted, stay).
    if (fields.length === 1 && fields[0] === '' && !lastQuoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) { columns = fields; continue; }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}

// Full quirk parser for one flagged record spanning text[s, e).
// Pushes the record's errors (in the order met) onto errors and returns
// its fields plus whether its last field opened with a quote.
function parseFlaggedRecord(text, s, e, recLine, recordRow, errors) {
  const fields = [];
  let pos = s;
  let lastQuoted = false;

  function err(code) { errors.push({ code, line: recLine, row: recordRow }); }

  // Unquoted stretch within [pos, e), appended onto value, scanned with
  // indexOf jumps between the characters that matter (, LF CR).
  // Returns {value, ended, added}; added counts characters kept.
  function readUnq(value) {
    let added = 0;
    let out = value;
    let seg = pos;
    for (;;) {
      let nc = text.indexOf(',', pos);
      let nn = text.indexOf('\n', pos);
      let nr = text.indexOf('\r', pos);
      if (nc === -1 || nc >= e) nc = Infinity;
      if (nn === -1 || nn >= e) nn = Infinity;
      if (nr === -1 || nr >= e) nr = Infinity;
      const idx = Math.min(nc, nn, nr);
      if (idx === Infinity) {
        out += text.slice(seg, e);
        added += e - seg;
        pos = e;
        return { value: out, ended: EOF_END, added };
      }
      if (idx === nc) {
        out += text.slice(seg, idx);
        added += idx - seg;
        pos = idx + 1;
        return { value: out, ended: COMMA, added };
      }
      if (idx === nn) {
        out += text.slice(seg, idx);
        added += idx - seg;
        pos = idx + 1;
        return { value: out, ended: BREAK, added };
      }
      // CR at idx: a CRLF pair ends the field, a lone CR is dropped.
      if (text[idx + 1] === '\n') {
        out += text.slice(seg, idx);
        added += idx - seg;
        pos = idx + 2;
        return { value: out, ended: BREAK, added };
      }
      out += text.slice(seg, idx);
      added += idx - seg;
      err('stray_cr');
      pos = idx + 1;
      seg = pos;
    }
  }

  // Quoted field whose opening quote is at pos. Jumps between quotes
  // and CRs with indexOf; plain stretches are sliced whole.
  function readQuoted() {
    const open = pos;
    pos += 1;
    let value = '';
    let seg = pos;
    let closed = false;
    for (;;) {
      if (pos >= e) break;
      let nq = text.indexOf('"', pos);
      let nr = text.indexOf('\r', pos);
      if (nq === -1 || nq >= e) nq = Infinity;
      if (nr === -1 || nr >= e) nr = Infinity;
      if (nq === Infinity && nr === Infinity) { pos = e; break; }
      if (nr < nq) {
        // CRLF and lone CR inside quotes each read as one LF.
        value += text.slice(seg, nr) + '\n';
        pos = nr + (text[nr + 1] === '\n' ? 2 : 1);
        seg = pos;
        continue;
      }
      if (text[nq + 1] === '"') {
        value += text.slice(seg, nq) + '"';
        pos = nq + 2;
        seg = pos;
        continue;
      }
      value += text.slice(seg, nq);
      pos = nq + 1;
      closed = true;
      break;
    }
    if (!closed) {
      // The quote never closes inside this record: literal quote, and
      // the text after it is read again as unquoted.
      pos = open + 1;
      err('unterminated_quote');
      return readUnq('"');
    }
    if (pos >= e) return { value, ended: EOF_END };
    const c = text[pos];
    if (c === ',') { pos += 1; return { value, ended: COMMA }; }
    if (c === '\n') { pos += 1; return { value, ended: BREAK }; }
    if (c === '\r' && text[pos + 1] === '\n') { pos += 2; return { value, ended: BREAK }; }
    // Junk after the closing quote is appended as it stands.
    const junk = readUnq(value);
    if (junk.added > 0) err('quote_junk');
    return junk;
  }

  for (;;) {
    lastQuoted = text[pos] === '"';
    const f = lastQuoted ? readQuoted() : readUnq('');
    fields.push(f.value);
    if (f.ended !== COMMA) break;
    // A comma at the very end of the span still opens one last field:
    // the next iteration reads it as empty and ends the record.
  }
  return { fields, lastQuoted };
}
