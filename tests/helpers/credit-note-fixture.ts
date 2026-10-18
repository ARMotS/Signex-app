/**
 * A credit note drawn to the client's real layout (CR-407712-C007H014):
 * positions and font sizes copied from that PDF's text layer, including what
 * the reader has to cope with — the product no and Qty a size larger and a
 * few points lower than the rest of the line, the "Other: / Brand: / Uom:" row
 * under every line, the credit's date in the "Invoice date" box beside an
 * Order date, and the totals block's amounts on slightly different baselines.
 */

import { PDFDocument, StandardFonts, type PDFFont, type PDFPage } from "pdf-lib";

const HEIGHT = 842;

export interface CreditFixtureLine {
  productCode: string;
  shortName: string;
  bin: string;
  description: string;
  qty: number;
  unitPrice: number;
  disc: number;
  nett: number;
}

export const CR_407712_LINES: CreditFixtureLine[] = [
  {
    productCode: "618ABG",
    shortName: "BATTERY",
    bin: "FLOOR",
    description: "BATT BM-618B41LB1 41AH 360CCA",
    qty: 1,
    unitPrice: 720,
    disc: 0,
    nett: 720,
  },
];

/**
 * Draw so pdf.js reports exactly this y back — the real note's numbers can be
 * copied straight in. (pdf.js-extract's y is the baseline, from the top.)
 */
function text(page: PDFPage, font: PDFFont, s: string, x: number, y: number, size: number) {
  page.drawText(s, { x, y: HEIGHT - y, size, font });
}

/** Right-aligned, as the note prints its figures. */
function right(page: PDFPage, font: PDFFont, s: string, rightX: number, top: number, size: number) {
  text(page, font, s, rightX - font.widthOfTextAtSize(s, size), top, size);
}

const money = (n: number) => n.toFixed(2);

export async function creditNotePdf(
  opts: {
    creditNo?: string;
    invoiceNo?: string | null;
    customer?: string;
    pages?: CreditFixtureLine[][];
    /** Override what the totals block prints (default: the lines' sum, 15% VAT). */
    subtotal?: number;
    vat?: number;
    total?: number;
  } = {}
): Promise<Buffer> {
  const doc = await PDFDocument.create();
  // Neighbouring cells in different fonts, as the real generator's runs
  // arrive separately: pdf.js stitches same-font runs on one baseline.
  const sans = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const mono = await doc.embedFont(StandardFonts.Courier);
  const times = await doc.embedFont(StandardFonts.TimesRoman);
  const timesBold = await doc.embedFont(StandardFonts.TimesRomanBold);
  const pages = opts.pages ?? [CR_407712_LINES];
  const customer = opts.customer ?? "HELDERBERG MOTOR SPARES";

  const sum = Math.round(pages.flat().reduce((s, l) => s + l.nett, 0) * 100) / 100;
  const subtotal = opts.subtotal ?? sum;
  const vat = opts.vat ?? Math.round(subtotal * 0.15 * 100) / 100;
  const total = opts.total ?? Math.round((subtotal + vat) * 100) / 100;

  pages.forEach((lines, pageIndex) => {
    const page = doc.addPage([595, HEIGHT]);
    text(page, bold, "ELECTRO CITY", 28.5, 43.5, 16);
    text(page, sans, "Tel: (011) 334 8355/9", 18, 131.7, 8);
    if (opts.invoiceNo !== null) {
      text(page, sans, "Inv No.", 183.8, 135.6, 10);
      text(page, bold, opts.invoiceNo ?? "384281", 219, 134.9, 10);
    }
    text(page, times, "Website: www.electro-city.co.za", 327, 134.8, 12);

    text(page, bold, "COPY", 29.3, 155.9, 12);
    text(page, bold, "CR NOTE", 78.8, 157.6, 16);
    text(page, mono, opts.creditNo ?? "407712", 225.9, 157.6, 16);
    text(page, sans, "Customer VAT no", 334.5, 156.6, 12);

    text(page, bold, "Invoice to:", 48, 181.3, 10);
    text(page, timesBold, "Deliver to:", 345, 181.3, 10);
    text(page, mono, customer, 49.5, 196.3, 10);
    text(page, times, customer, 346.5, 196.3, 10);
    text(page, mono, "24 FABRIK STREET", 50.3, 209.8, 10);
    text(page, times, "24 FABRIEK STREET", 346.5, 209.8, 10);

    text(page, sans, "Account no", 21, 262.9, 8);
    text(page, timesBold, "Order no", 111.8, 262.9, 8);
    text(page, sans, "Order date", 243, 262.9, 8);
    text(page, timesBold, "Branch", 426.8, 264.5, 10);
    text(page, sans, "Invoice date", 489, 262.9, 8);
    text(page, mono, "C007H014", 21.8, 279.5, 10);
    text(page, sans, "SCR", 111.8, 279.5, 10);
    text(page, mono, "19/07/2024", 244.5, 279.5, 10);
    text(page, sans, "C1", 423.8, 279.5, 10);
    text(page, mono, "16/10/2026", 490.5, 279.5, 10);

    text(page, bold, "Product no", 18.3, 305.7, 8);
    text(page, timesBold, "Bin", 199.5, 306.4, 8);
    text(page, bold, "Description", 247.5, 306.4, 8);
    text(page, timesBold, "Qty", 397.5, 305.7, 8);
    text(page, bold, "Unit Price", 432.8, 306.4, 8);
    text(page, timesBold, "Disc %", 489.8, 307.2, 8);
    text(page, bold, "Nett", 546.8, 306.4, 8);

    lines.forEach((line, i) => {
      const top = 330.8 + i * 26;
      text(page, sans, line.productCode, 14.3, top + 2.7, 12);
      text(page, mono, line.shortName, 102.8, top, 9);
      text(page, sans, line.bin, 201.8, top, 9);
      text(page, times, line.description, 246.8, top + 0.7, 9);
      right(page, sans, String(line.qty), 429.8, top + 3.5, 12);
      right(page, mono, money(line.unitPrice), 487.5, top + 0.7, 9);
      right(page, sans, String(line.disc), 511.5, top + 0.7, 9);
      right(page, mono, money(line.nett), 576.8, top + 0.7, 9);

      text(page, sans, "Other:", 17.3, top + 13.8, 10);
      text(page, mono, `${line.productCode.slice(0, 5)},,,,`, 45.8, top + 13.4, 8);
      text(page, sans, "Brand:", 352.5, top + 14, 10);
      text(page, mono, "UNITECH 12M WO", 390.8, top + 15.7, 9);
      text(page, sans, "Uom:", 507.8, top + 14.8, 10);
      text(page, mono, "EACH", 534, top + 15.7, 9);
    });

    text(page, sans, "All Goods remain the property of Electro City cc until paid for in full.", 19.5, 611.3, 8);
    text(page, sans, "Goods received in good order and condition.", 19.5, 621, 8);
    text(page, sans, "W:", 362.3, 653.5, 11);
    text(page, mono, "10.200", 431.4, 654.2, 11);
    text(page, bold, "Signed:", 26.3, 656.2, 10);
    text(page, bold, "Date:", 199.5, 657, 10);

    if (pageIndex === pages.length - 1) {
      text(page, bold, "SUB TOTAL", 443.3, 674.2, 10);
      right(page, mono, money(subtotal), 579, 674.2, 10);
      text(page, sans, "DELIVERY", 27, 687, 10);
      text(page, bold, "TOTAL VAT", 442.5, 692.2, 10);
      right(page, mono, money(vat), 579, 690.7, 10);
      text(page, sans, "NEDBANK BR128405 ACC1043332081", 26.3, 718.5, 10);
      text(page, mono, "CAPE TOWN", 282.8, 719.5, 9);
      text(page, bold, "TOTAL", 451.5, 720.8, 12);
      text(page, sans, "R", 492.8, 722.9, 12);
      right(page, mono, money(total), 579.7, 720.1, 14);
    }

    text(page, sans, "Page no:", 19.5, 754.4, 10);
    text(page, mono, `${pageIndex + 1} of ${pages.length}`, 75, 754.4, 10);
  });

  return Buffer.from(await doc.save());
}
