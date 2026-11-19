/**
 * printed-time-fix.ts
 * Correct times that documents we filed printed in UTC instead of South
 * African time ("19 Nov 2026, 07:35" for a 09:35 signature). See lib/sa-time.ts
 * for the cause; prisma/fix-printed-times.ts runs this over every scope.
 *
 * Only OUR text is touched, and only where it proves itself wrong: a printed
 * time is rewritten when it equals one of the document's known true instants
 * (the invoice's own `Signed:<ISO>` subject, the collection's collectedAt, the
 * credit note's signedAt) written in UTC. Anything else — an invoice's own
 * printed dates, a time already in SA time, a time we cannot account for — is
 * left as it is and reported. That is also what makes a second run, or a file
 * signed after the fix, a no-op.
 *
 * Only digits change. Every digit is the same width in Helvetica and
 * Helvetica-Bold (556/1000 em), so nothing on the page moves. A correction
 * that would change the month name (a signature between 00:00 and 02:00 SA
 * time on the 1st) would change the line's width, and is reported for a
 * person instead.
 *
 * pdf-lib writes text as `<hex> Tj` in WinAnsi, one call per line, so a
 * wrapped "Signed by … · 19 Nov 2026, 07:35" can be split over two strings at
 * any space. The strings of a stream are read joined by a space, which is the
 * space the wrap took out.
 */

import { PDFArray, PDFDocument, PDFName, PDFRawStream, PDFRef, decodePDFRawStream } from "pdf-lib";
import { formatSaDateTime } from "./sa-time";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const STAMP = /(\d{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}),? (\d{2}):(\d{2})/g;
const HEX_TJ = /<([0-9A-Fa-f\s]*)>(\s*Tj)/g;

/** "19 Nov 2026, 07:35" — the shape every affected document printed, in UTC. */
export function formatUtcStamp(at: Date): string {
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${p2(at.getUTCDate())} ${MONTHS[at.getUTCMonth()]} ${at.getUTCFullYear()}, ${p2(at.getUTCHours())}:${p2(at.getUTCMinutes())}`;
}

export interface PrintedTimeReport {
  /** The corrected PDF, or null when nothing needed changing. */
  pdf: Buffer | null;
  /** "19 Nov 2026, 07:35 → 19 Nov 2026, 09:35" per correction. */
  fixed: string[];
  /** Printed times that already read as South African time. */
  alreadyRight: number;
  /** Matched a true instant, but the month name would change — fix by hand. */
  manual: string[];
  /** Times in our text that match no instant we know of. Left alone. */
  unexplained: string[];
}

interface HexString {
  start: number; // offset of "<" in the decoded stream text
  end: number; // offset just past ">"
  text: string[]; // one WinAnsi char per entry
}

/** Collapse "19 Nov 2026, 07:35" / "19 Nov 2026 07:35" to one comparable key. */
const keyOf = (s: string) => s.replace(",", "");

export async function correctPrintedTimes(pdfBytes: Uint8Array, instants: Date[]): Promise<PrintedTimeReport> {
  const report: PrintedTimeReport = { pdf: null, fixed: [], alreadyRight: 0, manual: [], unexplained: [] };
  const wrong = new Map<string, Date>(); // UTC rendering → the instant
  const right = new Set<string>();
  for (const at of instants) {
    wrong.set(keyOf(formatUtcStamp(at)), at);
    right.add(keyOf(formatSaDateTime(at)));
  }

  const doc = await PDFDocument.load(pdfBytes, { updateMetadata: false });
  let changedAny = false;

  for (const page of doc.getPages()) {
    const contents = page.node.get(PDFName.of("Contents"));
    const refs: PDFRef[] =
      contents instanceof PDFRef
        ? [contents]
        : contents instanceof PDFArray
          ? contents.asArray().filter((r): r is PDFRef => r instanceof PDFRef)
          : [];

    for (const ref of refs) {
      const stream = doc.context.lookup(ref);
      if (!(stream instanceof PDFRawStream)) continue;
      let src: string;
      try {
        src = Buffer.from(decodePDFRawStream(stream).decode()).toString("latin1");
      } catch {
        continue; // a filter we cannot decode is not one pdf-lib wrote
      }

      const strings: HexString[] = [];
      for (const m of src.matchAll(HEX_TJ)) {
        const hex = m[1].replace(/\s+/g, "");
        if (hex.length % 2 !== 0) continue;
        const text: string[] = [];
        for (let i = 0; i < hex.length; i += 2) text.push(String.fromCharCode(parseInt(hex.slice(i, i + 2), 16)));
        strings.push({ start: m.index!, end: m.index! + m[1].length + 2, text });
      }
      if (strings.length === 0) continue;

      // The strings joined by a space, each character mapped back to its place.
      const joined: string[] = [];
      const where: ([number, number] | null)[] = [];
      strings.forEach((s, si) => {
        if (si > 0) {
          joined.push(" ");
          where.push(null);
        }
        s.text.forEach((ch, ci) => {
          joined.push(ch);
          where.push([si, ci]);
        });
      });

      let changedHere = false;
      for (const m of joined.join("").matchAll(STAMP)) {
        const printed = m[0];
        const key = keyOf(printed);
        if (right.has(key)) {
          report.alreadyRight += 1;
          continue;
        }
        const at = wrong.get(key);
        if (!at) {
          if (/\d{2}:\d{2}$/.test(printed)) report.unexplained.push(printed);
          continue;
        }
        const target = formatSaDateTime(at);
        const targetKey = keyOf(target);
        const out = printed.includes(",") ? target : targetKey;
        if (out.length !== printed.length || out.slice(3, 6) !== printed.slice(3, 6)) {
          report.manual.push(`${printed} → ${target}`);
          continue;
        }
        for (let i = 0; i < printed.length; i++) {
          if (printed[i] === out[i]) continue;
          const at2 = where[m.index! + i];
          if (!at2) throw new Error("A correction landed on a line break"); // cannot happen: only digits differ
          strings[at2[0]].text[at2[1]] = out[i];
        }
        report.fixed.push(`${printed} → ${out}`);
        changedHere = true;
      }
      if (!changedHere) continue;

      // Write the strings back in place, from the end so offsets hold.
      let next = src;
      for (const s of [...strings].reverse()) {
        const hex = s.text.map((ch) => ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")).join("");
        next = next.slice(0, s.start) + `<${hex}>` + next.slice(s.end);
      }
      doc.context.assign(ref, doc.context.flateStream(Buffer.from(next, "latin1")));
      changedAny = true;
    }
  }

  if (changedAny) report.pdf = Buffer.from(await doc.save());
  return report;
}

/** The true signing instant an invoice we signed carries in its subject. */
export async function signedInstantOf(pdfBytes: Uint8Array): Promise<Date | null> {
  const doc = await PDFDocument.load(pdfBytes, { updateMetadata: false });
  const m = /^Signed:(\d{4}-\d{2}-\d{2}T[\d:.]+Z)$/.exec(doc.getSubject() ?? "");
  return m ? new Date(m[1]) : null;
}
