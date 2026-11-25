/**
 * trip-number.ts
 * Issuing manual trip numbers (format: lib/trip-number-format.ts).
 *
 * Only a trip built in Signex is issued one. Nothing calls this for an Excel
 * sheet: a Trip program sheet keeps its file's name.
 */
import { Prisma } from "@prisma/client";
import { scopedPrisma } from "./db-scoped";
import { saDayKey } from "./sa-time";
import { formatManualTripNumber, readBranchCode } from "./trip-number-format";

/**
 * This scope's branch code (Settings → Trip Numbers), or "" for none.
 *
 * Read directly rather than through readConfig, which falls back to defaults
 * on a database error: a number issued without the code because of a blip
 * would read as another branch's. A failed read throws instead.
 */
export async function readBranchCodeSetting(tenantId: string): Promise<string> {
  const row = await scopedPrisma(tenantId).appConfig.findUnique({
    where: { tenantId_key: { tenantId, key: "branchCode" } },
  });
  const code = readBranchCode(row?.value ?? "");
  return code.ok ? code.value : "";
}

const isUniqueViolation = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";

/**
 * Issue the next manual trip number for this scope: SX-{CODE}-{YYMMDD}-{NN}.
 *
 * One atomic increment of the scope's counter for the Johannesburg day, so
 * two dispatchers building at once never get the same number, and a number
 * is never issued again after its trip is completed (and deleted). A number
 * issued and then not used (a draft thrown away) is simply skipped.
 */
export async function issueManualTripNumber(tenantId: string, at: Date = new Date()): Promise<string> {
  const db = scopedPrisma(tenantId);
  const day = saDayKey(at);
  const code = await readBranchCodeSetting(tenantId);

  const bump = () =>
    db.tripNumberCounter.upsert({
      where: { tenantId_day: { tenantId, day } },
      create: { day, value: 1 },
      update: { value: { increment: 1 } },
      select: { value: true },
    });

  let counter: { value: number };
  try {
    counter = await bump();
  } catch (err) {
    // Two first-of-the-day requests can both try to create the row; the loser
    // retries once and increments the row the winner made.
    if (!isUniqueViolation(err)) throw err;
    counter = await bump();
  }

  return formatManualTripNumber(code, day, counter.value);
}
