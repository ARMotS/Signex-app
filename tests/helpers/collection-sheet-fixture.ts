/**
 * A collection sheet drawn to the client's real layout (CRCOL-1797): positions
 * and font sizes copied from that PDF's text layer, including the quirks the
 * reader has to cope with — each line on two baselines in two sizes, the
 * raised Reason digit, the joint "Qty Returned" heading and the unlabelled
 * short-name column.
 */

import { PDFDocument, StandardFonts, type PDFFont, type PDFPage } from "pdf-lib";

const HEIGHT = 842;

export interface FixtureLine {
  itemCode: string;
  shortName: string;
  description: string;
  qty: number;
  reason: string;
}

export const CRCOL_1797_LINES: FixtureLine[] = [
  { itemCode: "CABLE 7COR", shortName: "CABLE 7COR 0.75", description: "0.75MM 7COR CABLE P/30MR", qty: 1, reason: "1" },
  { itemCode: "REG", shortName: "REG", description: "12V HYBRID REG (MONARK)", qty: 1, reason: "2" },
  { itemCode: "RELAY", shortName: "RELAY", description: "12V 5PIN 30A BOSCH RELAY", qty: 2, reason: "3" },
];

/** Draw at a top-left y, the way pdf.js reports it back. */
function text(page: PDFPage, font: PDFFont, s: string, x: number, top: number, size: number) {
  page.drawText(s, { x, y: HEIGHT - top - size, size, font });
}

export async function collectionSheetPdf(
  opts: {
    number?: string;
    invoiceNo?: string | null;
    customer?: string;
    pages?: FixtureLine[][];
    /** Print the number as its own run, well clear of the title (other generators do). */
    numberApart?: boolean;
  } = {}
): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const mono = await doc.embedFont(StandardFonts.Courier);
  const sans = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const pages = opts.pages ?? [CRCOL_1797_LINES];

  pages.forEach((lines, pageIndex) => {
    const page = doc.addPage([595, HEIGHT]);
    text(page, bold, "ELECTRO CITY CC", 29, 34, 16);
    text(page, bold, "COPY", 137, 157, 12);
    if (opts.numberApart) {
      text(page, bold, "CREDIT COLLECTION SHEET", 195, 159, 12);
      text(page, mono, opts.number ?? "001797", 420, 159, 12);
    } else {
      text(page, bold, `CREDIT COLLECTION SHHET ${opts.number ?? "001797"}`, 195, 159, 12);
    }

    text(page, bold, "Collection Address:", 49, 184, 10);
    text(page, sans, "Account no", 353, 192, 8);
    text(page, mono, "V002", 422, 191, 10);
    text(page, mono, opts.customer ?? "VISA AUTO ELECTRICAL", 50, 199, 10);
    if (opts.invoiceNo !== null) {
      text(page, sans, "Invoice No.", 353, 209, 8);
      text(page, bold, opts.invoiceNo ?? "130522", 437, 208, 10);
    }
    text(page, mono, "FRENCH STREET 13", 50, 213, 10);
    text(page, mono, "VRYBURG", 50, 226, 10);
    text(page, sans, "Collection date", 341, 226, 8);
    text(page, mono, "25/11/2025", 423, 224, 10);
    text(page, sans, "Page no:", 362, 244, 8);
    text(page, mono, String(pageIndex + 1), 422, 241, 10);

    text(page, bold, "Product no", 18, 270, 8);
    text(page, bold, "Description", 221, 270, 8);
    text(page, bold, "Qty", 340, 270, 8);
    text(page, bold, "Returned", 362, 270, 8);
    text(page, bold, "Reason", 479, 270, 8);

    lines.forEach((line, i) => {
      const top = 296 + i * 22.5;
      text(page, sans, line.itemCode, 14, top + 2, 12);
      // Its own font, as on the real sheet: pdf.js stitches same-font runs on
      // one baseline into a single item, and the real generator's cells
      // arrive as separate runs.
      text(page, mono, line.shortName, 103, top, 7);
      text(page, sans, line.description, 180, top, 9);
      text(page, sans, String(line.qty), 361, top + 2, 12);
      text(page, sans, "0", 390, top, 9);
      text(page, sans, line.reason, 397, top - 2.3, 8);
    });

    const footer = 296 + lines.length * 22.5 + 3;
    text(page, sans, "All Goods remain the property of Electro City cc until paid for in full.", 21, footer, 8);
    text(page, sans, "Goods received in good order and condition.", 21, footer + 10, 8);
    text(page, bold, "Signed:", 122, footer + 55, 8);
    text(page, bold, "Date:", 284, footer + 55, 8);
  });

  return Buffer.from(await doc.save());
}
