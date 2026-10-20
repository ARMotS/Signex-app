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
  /** CR-407710 prints a second code under some product nos (REG1006). */
  supplierCode?: string;
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

/** CR-407710 — the later layout, crediting invoice 130522 (collection 1797). */
export const CR_407710_LINES: CreditFixtureLine[] = [
  {
    productCode: "220740I",
    shortName: "CABLE 7COR 0.75 P30M",
    bin: "17G2",
    description: "0.75MM 7COR CABLE P/30MR",
    qty: 1,
    unitPrice: 767.4,
    disc: 30,
    nett: 537.18,
  },
  {
    productCode: "431456M",
    shortName: "REG",
    bin: "11B5",
    description: "12V HYBRID REG (MONARK)",
    qty: 1,
    unitPrice: 202.37,
    disc: 25,
    nett: 151.78,
    supplierCode: "REG1006",
  },
  {
    productCode: "0986AH0250",
    shortName: "RELAY",
    bin: "12F7",
    description: "12V 5PIN 30A BOSCH RELAY",
    qty: 2,
    unitPrice: 57.7,
    disc: 25,
    nett: 86.54,
    supplierCode: "C4020",
  },
];

/**
 * Where each layout prints things. CR-407710 moves the invoice number from
 * "Inv No." above the title into the heading row (between Order date and
 * Branch), which pushes that row and the table 36pt down; its line cells are
 * all one size, and its bins print a few points left of the Bin heading.
 */
const LAYOUTS = {
  "CR-407712": {
    shift: 0,
    codeSize: 12, codeDy: 2.7, shortX: 102.8, binX: 201.8,
    qtyH: 397.5, unitH: 432.8, discH: 489.8, nettH: 546.8,
    qtyR: 429.8, qtySize: 12, qtyDy: 3.5, priceR: 487.5, discR: 511.5, nettR: 576.8,
  },
  "CR-407710": {
    shift: 36,
    codeSize: 9, codeDy: 0, shortX: 84.8, binX: 192.8,
    qtyH: 414, unitH: 439.5, discH: 497.3, nettH: 558,
    qtyR: 431.3, qtySize: 9, qtyDy: 0.7, priceR: 491.3, discR: 516, nettR: 580.5,
  },
} as const;

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
    layout?: keyof typeof LAYOUTS;
  } = {}
): Promise<Buffer> {
  const layout = opts.layout ?? "CR-407712";
  const g = LAYOUTS[layout];
  const columnInvoice = layout === "CR-407710";
  const doc = await PDFDocument.create();
  // Neighbouring cells in different fonts, as the real generator's runs
  // arrive separately: pdf.js stitches same-font runs on one baseline.
  const sans = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const mono = await doc.embedFont(StandardFonts.Courier);
  const times = await doc.embedFont(StandardFonts.TimesRoman);
  const timesBold = await doc.embedFont(StandardFonts.TimesRomanBold);
  const pages = opts.pages ?? [columnInvoice ? CR_407710_LINES : CR_407712_LINES];
  const customer = opts.customer ?? (columnInvoice ? "VISA AUTO ELECTRICAL" : "HELDERBERG MOTOR SPARES");

  const sum = Math.round(pages.flat().reduce((s, l) => s + l.nett, 0) * 100) / 100;
  const subtotal = opts.subtotal ?? sum;
  const vat = opts.vat ?? Math.round(subtotal * 0.15 * 100) / 100;
  const total = opts.total ?? Math.round((subtotal + vat) * 100) / 100;

  pages.forEach((lines, pageIndex) => {
    const page = doc.addPage([595, HEIGHT]);
    text(page, bold, "ELECTRO CITY", 28.5, 43.5, 16);
    text(page, sans, "Tel: (011) 334 8355/9", 18, 131.7, 8);
    if (opts.invoiceNo !== null && !columnInvoice) {
      text(page, sans, "Inv No.", 183.8, 135.6, 10);
      text(page, bold, opts.invoiceNo ?? "384281", 219, 134.9, 10);
    }
    text(page, times, "Website: www.electro-city.co.za", 327, 134.8, 12);

    if (columnInvoice) {
      text(page, bold, "CR NOTE", 78.8, 163.6, 16);
      text(page, mono, opts.creditNo ?? "407710", 212.4, 163.6, 16);
      text(page, sans, "Customer VAT no", 334.5, 162.6, 12);
      text(page, mono, "4770255505", 453, 163.4, 12);
    } else {
      text(page, bold, "COPY", 29.3, 155.9, 12);
      text(page, bold, "CR NOTE", 78.8, 157.6, 16);
      text(page, mono, opts.creditNo ?? "407712", 225.9, 157.6, 16);
      text(page, sans, "Customer VAT no", 334.5, 156.6, 12);
    }

    text(page, bold, "Invoice to:", 48, 181.3, 10);
    text(page, timesBold, "Deliver to:", 345, 181.3, 10);
    text(page, mono, customer, 49.5, 196.3, 10);
    text(page, times, customer, 346.5, 196.3, 10);
    text(page, mono, "24 FABRIK STREET", 50.3, 209.8, 10);
    text(page, times, "24 FABRIEK STREET", 346.5, 209.8, 10);

    const s = g.shift;
    text(page, sans, "Account no", 21, 262.9 + s, 8);
    text(page, timesBold, "Order no", 111.8, 262.9 + s, 8);
    text(page, sans, "Order date", 243, 262.9 + s, 8);
    text(page, timesBold, "Branch", 426.8, 264.5 + s, 10);
    text(page, sans, "Invoice date", 489, 262.9 + s, 8);
    if (columnInvoice) {
      text(page, mono, "V002", 21.8, 279.5 + s, 10);
      text(page, sans, "JANNIE", 111.8, 279.5 + s, 10);
      text(page, mono, "01/10/2021", 244.5, 279.5 + s, 10);
      text(page, sans, "B1", 423.8, 279.5 + s, 10);
      text(page, mono, "25/11/2025", 490.5, 279.5 + s, 10);
      if (opts.invoiceNo !== null) {
        // A heading of its own in this row, its number set off-centre under it.
        text(page, bold, "Invoice no", 348, 298.2, 8);
        text(page, bold, opts.invoiceNo ?? "130522", 364.5, 315.5, 10);
      }
    } else {
      text(page, mono, "C007H014", 21.8, 279.5, 10);
      text(page, sans, "SCR", 111.8, 279.5, 10);
      text(page, mono, "19/07/2024", 244.5, 279.5, 10);
      text(page, sans, "C1", 423.8, 279.5, 10);
      text(page, mono, "16/10/2026", 490.5, 279.5, 10);
    }

    text(page, bold, "Product no", 18.3, 305.7 + s, 8);
    text(page, timesBold, "Bin", 199.5, 306.4 + s, 8);
    text(page, bold, "Description", 247.5, 306.4 + s, 8);
    text(page, timesBold, "Qty", g.qtyH, 305.7 + s, 8);
    text(page, bold, "Unit Price", g.unitH, 306.4 + s, 8);
    text(page, timesBold, "Disc %", g.discH, 307.2 + s, 8);
    text(page, bold, "Nett", g.nettH, 306.4 + s, 8);

    lines.forEach((line, i) => {
      const top = columnInvoice ? 369.8 + i * 30 : 330.8 + i * 26;
      text(page, sans, line.productCode, columnInvoice ? 17.3 : 14.3, top + g.codeDy, g.codeSize);
      text(page, mono, line.shortName, g.shortX, top, 9);
      text(page, sans, line.bin, g.binX, top, 9);
      text(page, times, line.description, 246.8, top + 0.7, 9);
      right(page, sans, String(line.qty), g.qtyR, top + g.qtyDy, g.qtySize);
      right(page, mono, money(line.unitPrice), g.priceR, top + 0.7, 9);
      right(page, sans, String(line.disc), g.discR, top + 0.7, 9);
      right(page, mono, money(line.nett), g.nettR, top + 0.7, 9);

      if (line.supplierCode) text(page, sans, line.supplierCode, 18, top + 14.2, 9);
      else if (!columnInvoice) {
        text(page, sans, "Other:", 17.3, top + 13.8, 10);
        text(page, mono, `${line.productCode.slice(0, 5)},,,,`, 45.8, top + 13.4, 8);
      }
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
