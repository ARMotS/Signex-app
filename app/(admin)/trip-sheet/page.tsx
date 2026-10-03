"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useLiveSync } from "@/hooks/useLiveSync";
import { FilterSearch } from "@/components/admin/FilterSearch";
import { matchesTokens, tokenizeQuery } from "@/lib/search-match";

interface TripStop {
  id: string;
  stopNumber: number;
  invoiceNumber: string;
  customerName: string;
  address: string;
  nop: number;
  invoiceFile?: string;
  status: "PENDING" | "IN_PROGRESS" | "SIGNED";
  signedAt?: string;
  emailSentAt?: string;
  emailStatus?: string;
  emailError?: string | null;
  contact?: { email?: string };
  collections?: TripCollection[];
}

/** A collection hanging off a stop — goods coming back with the driver. */
interface TripCollection {
  id: string;
  collectionNo: string;
  type: "CREDIT_RETURN" | "NON_CREDIT_UPLIFT";
  upliftSubtype?: string | null;
  originalInvoiceNo?: string | null;
  status: "PENDING" | "COLLECTED" | "PARTIAL" | "NOT_AVAILABLE" | "REFUSED";
  exceptionReason?: string | null;
  expectedQty?: number | null;
  collectedQty?: number | null;
  sourceFilePath?: string | null;
  signedFilePath?: string | null;
}

/** One collection frozen into a completed sheet's snapshot. */
interface ArchivedCollection {
  collectionNo: string;
  type: string;
  upliftSubtype: string | null;
  originalInvoiceNo: string | null;
  status: string;
  exceptionReason: string | null;
  notes: string | null;
  expectedQty: number | null;
  collectedQty: number | null;
  customerName: string;
  stopNumber: number | null;
  signedByName: string | null;
  collectedAt: string | null;
  sourceFilePath: string | null;
  signedFileId: string | null;
  signedFilePath: string | null;
}

const COLLECTION_STATUS_LABEL: Record<string, string> = {
  PENDING: "Pending",
  COLLECTED: "Collected",
  PARTIAL: "Partial",
  NOT_AVAILABLE: "Not available",
  REFUSED: "Refused",
};

/** The three outcomes accounts has to look at before raising a credit. */
const COLLECTION_EXCEPTIONS = new Set(["PARTIAL", "NOT_AVAILABLE", "REFUSED"]);

interface TripSheet {
  id: string;
  driverId: string;
  driverName: string;
  regNo: string;
  status: "ACTIVE" | "QUEUED";
  uploadedAt: string;
  uploadedBy: string;
  sourceFilename: string;
  stops: TripStop[];
}

interface MatchResult {
  driverId: string;
  driverName: string;

  regNo: string;
  stops: TripStop[];
  unmatchedInvoices: string[];
  unmatchedCollections?: string[];
}

interface AlreadySignedInvoice {
  invoiceNumber: string;
  signedAt: string | null;
  driverName: string | null;
  source: "database" | "filesystem";
}

/** A row on the sheet whose PDF is not in the invoice folder. */
interface MissingInvoice {
  invoiceNumber: string;
  customerName: string;
  driverName: string;
  stopId: string;
}

interface PreviewData {
  success: boolean;
  filename?: string;
  preview: {
    totalRows: number;
    matchedInvoices: number;
    unmatchedInvoices: number;
    totalCollections?: number;
    matchedCollections?: number;
    unmatchedCollections?: number;
    driverResults: MatchResult[];
    alreadySigned: AlreadySignedInvoice[];
    missingInvoices: MissingInvoice[];
  };
}

interface Stats {
  totalStops: number;
  signed: number;
  pending: number;
  inProgress: number;
  activeDrivers: number;
}

/** One stop frozen into a completed sheet's snapshot — see CompletedTripSheet. */
interface ArchivedStop {
  stopNumber: number;
  invoiceNumber: string;
  customerName: string;
  address: string;
  nop: number;
  signedAt: string | null;
  emailStatus: string;
}

interface CompletedTripSheet {
  id: string;
  driverId: string;
  driverName: string;
  regNo: string;
  sourceFilename: string;
  archivedFile: string | null;
  uploadedAt: string;
  completedAt: string;
  completedBy: string | null;
  totalStops: number;
  signedStops: number;
  totalCollections?: number;
  collectedCollections?: number;
  stops: ArchivedStop[];
  /** Absent on trips archived before collections existed — read as []. */
  collections?: ArchivedCollection[];
}

interface DriverAccount {
  id: string;
  name: string;
  active: boolean;
}

interface CloudTripFile {
  filename: string;
  sizeBytes: number;
  lastModified: string;
  extension: string;
  imported: boolean;
  importedAt?: string;
  importStatus?: string;
}

interface TripSheetDuplicateGroup {
  baseName: string;
  filenames: string[];
}

interface CloudFolderData {
  path: string;
  accessible: boolean;
  provider: string;
  totalFiles: number;
  newFiles: number;
  files: CloudTripFile[];
  duplicates?: TripSheetDuplicateGroup[];
  cloud: {
    provider: string;
    label: string;
    icon: string;
    synced: boolean;
  };
}

export default function TripSheetPage() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragActive, setDragActive] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [uploadedFile, setUploadedFile] = useState<File | null>(null);
  const [showUpload, setShowUpload] = useState(false);
  const [showActiveTrips, setShowActiveTrips] = useState(true);

  // Active trip sheets
  const [tripSheets, setTripSheets] = useState<TripSheet[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [expandedTrip, setExpandedTrip] = useState<string | null>(null);

  // Completed trip sheets — read from the archive, not from live trip sheets:
  // completing a sheet deletes it. See the CompletedTripSheet model.
  const [tripTab, setTripTab] = useState<"active" | "completed">("active");
  const [completedSheets, setCompletedSheets] = useState<CompletedTripSheet[]>([]);
  const [completedRange, setCompletedRange] = useState<"today" | "all">("today");
  /** Local midnight, as the server computed it. Reading the clock during render
   *  is impure, so "Today" is decided from this rather than from `new Date()`. */
  const [completedDayStart, setCompletedDayStart] = useState<string | null>(null);
  const [completedLoading, setCompletedLoading] = useState(false);
  const [expandedCompleted, setExpandedCompleted] = useState<string | null>(null);

  // Driver assignment for unassigned rows
  const [drivers, setDrivers] = useState<DriverAccount[]>([]);
  const [assignToDriverId, setAssignToDriverId] = useState<string>("");

  // Cloud folder state
  const [cloudFolder, setCloudFolder] = useState<CloudFolderData | null>(null);
  const [cloudLoading, setCloudLoading] = useState(false);
  const [cloudImporting, setCloudImporting] = useState<string | null>(null);
  const [importSourceFile, setImportSourceFile] = useState<string | null>(null);

  // Pagination state
  const ITEMS_PER_PAGE = 20;
  const [cloudPage, setCloudPage] = useState(1);
  const [tripPage, setTripPage] = useState(1);

  // Search state. Two boxes rather than one: the folder listing and the
  // deployed sheets are separate piles of paper, and someone hunting an
  // invoice number in a live run is not also filtering the files still
  // waiting to be imported.
  const [cloudQuery, setCloudQuery] = useState("");
  const [tripQuery, setTripQuery] = useState("");

  // Selection state — cloud folder files
  const [selectedCloudFiles, setSelectedCloudFiles] = useState<Set<string>>(new Set());
  const [deletingCloudFiles, setDeletingCloudFiles] = useState(false);
  const [showCloudDeleteConfirm, setShowCloudDeleteConfirm] = useState(false);

  // Selection state — active trip sheets
  const [selectedTrips, setSelectedTrips] = useState<Set<string>>(new Set());
  const [deletingTrips, setDeletingTrips] = useState(false);
  const [showTripDeleteConfirm, setShowTripDeleteConfirm] = useState(false);

  // Already-signed invoice skip state
  const [skippedInvoices, setSkippedInvoices] = useState<Set<string>>(new Set());

  // Missing-invoice resolution: upload the PDF, skip the stop, or deploy the
  // stop without paperwork. The deploy is gated until each one has an answer —
  // the server re-checks the same rule, so this is a prompt, not the guarantee.
  const missingFileInputRef = useRef<HTMLInputElement>(null);
  const bulkInvoiceInputRef = useRef<HTMLInputElement>(null);
  /** Which missing invoice the hidden file picker was opened for */
  const [uploadTargetInvoice, setUploadTargetInvoice] = useState<string | null>(null);
  const [invoiceUploads, setInvoiceUploads] = useState<
    Record<string, { state: "uploading" | "done" | "failed"; message?: string }>
  >({});
  /** A file that clashed with an existing one, held so "Replace" can resend it */
  const [invoiceConflict, setInvoiceConflict] = useState<
    { key: string; file: File; invoiceNumber?: string } | null
  >(null);
  const [recheckingInvoices, setRecheckingInvoices] = useState(false);
  const [invoiceDestination, setInvoiceDestination] = useState<string | null>(null);

  // Complete/archive state
  const [completingTrips, setCompletingTrips] = useState(false);
  const [showCompleteConfirm, setShowCompleteConfirm] = useState(false);
  const [completingTripId, setCompletingTripId] = useState<string | null>(null);
  const [completeSuccess, setCompleteSuccess] = useState<string | null>(null);

  // Email resend state
  const [emailSending, setEmailSending] = useState<Record<string, "sending" | "sent" | "failed">>({});

  const handleResendEmail = async (stop: TripStop, driverName: string) => {
    setEmailSending((prev) => ({ ...prev, [stop.id]: "sending" }));
    try {
      const res = await fetch(`/api/invoices/${stop.id}/notify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ driverName }),
      });
      const data = await res.json();
      if (!res.ok) {
        setEmailSending((prev) => ({ ...prev, [stop.id]: "failed" }));
        setError(data.error || "Failed to send email");
      } else if (data.skipped) {
        setEmailSending((prev) => ({ ...prev, [stop.id]: "failed" }));
        setError(`Email skipped: ${data.reason}`);
      } else {
        setEmailSending((prev) => ({ ...prev, [stop.id]: "sent" }));
        setTimeout(() => setEmailSending((prev) => { const next = { ...prev }; delete next[stop.id]; return next; }), 4000);
      }
    } catch {
      setEmailSending((prev) => ({ ...prev, [stop.id]: "failed" }));
      setError("Failed to send email");
    }
  };

  const fetchCloudFolder = useCallback(async () => {
    try {
      const res = await fetch("/api/trip-sheet/folder");
      if (res.ok) {
        const data = await res.json();
        setCloudFolder(data);
      }
    } catch {
      // ignore
    }
  }, []);

  const fetchTripSheets = useCallback(async () => {
    try {
      const res = await fetch("/api/trip-sheet");
      const data = await res.json();
      setTripSheets(data.tripSheets || []);
      setStats(data.stats || null);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchCompletedSheets = useCallback(async () => {
    setCompletedLoading(true);
    try {
      // "Today" is the dispatcher's own day, not the server's UTC one.
      const tzOffset = new Date().getTimezoneOffset();
      const res = await fetch(
        `/api/trip-sheet/completed?tzOffset=${tzOffset}${completedRange === "all" ? "&range=all" : ""}`
      );
      if (res.ok) {
        const data = await res.json();
        setCompletedSheets(data.completed || []);
        setCompletedDayStart(data.dayStart ?? null);
      }
    } catch {
      // ignore — the tab keeps whatever it last showed
    } finally {
      setCompletedLoading(false);
    }
  }, [completedRange]);

  // Kept out of the mount effect below: this one re-runs when the range toggle
  // moves, and folding it in there would tear down and rebuild the cloud poll
  // interval every time someone switched between Today and All.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchCompletedSheets();
  }, [fetchCompletedSheets]);

  useEffect(() => {
    fetchTripSheets();
    fetchCloudFolder();
    // Also fetch drivers for assignment dropdown
    fetch("/api/drivers")
      .then((r) => r.json())
      .then((data) => setDrivers((data.drivers || []).filter((d: DriverAccount) => d.active)))
      .catch(() => {});

    // Where an uploaded invoice would land — shown before anyone uploads, so
    // it is obvious whether the PDF is going to OneDrive or the synced folder.
    fetch("/api/invoices/upload")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => setInvoiceDestination(data?.destination ?? null))
      .catch(() => {});

    // Auto-poll the cloud folder every 30 seconds.
    //
    // Skipped while the tab is hidden: this call lists a remote OneDrive folder
    // rather than reading the database, so a forgotten background tab was
    // spending Graph quota all day to look at a folder nobody was watching.
    // Checking on the way back to the tab covers the gap.
    const pollInterval = setInterval(() => {
      if (!document.hidden) fetchCloudFolder();
    }, 30000);

    const onVisible = () => {
      if (!document.hidden) fetchCloudFolder();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      clearInterval(pollInterval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [fetchTripSheets, fetchCloudFolder]);

  /**
   * Reflect driver progress as it happens — stops moving to SIGNED, and sheets
   * disappearing as they are completed. Cheap: the change feed is two indexed
   * aggregates, and only a real change triggers the full refetch below.
   *
   * Completing a sheet deletes it, which is exactly what moves the cursor, so
   * the same tick refreshes the archive the sheet just moved into.
   */
  const refreshTripData = useCallback(() => {
    fetchTripSheets();
    fetchCompletedSheets();
  }, [fetchTripSheets, fetchCompletedSheets]);

  useLiveSync(refreshTripData);

  // ─── Search narrowing ──────────────────────────────────────────────────
  //
  // Every list on this page arrives whole — the folder in one response, the
  // sheets in another — so narrowing happens here rather than over the
  // network. The matching rules live in lib/search-match.ts.

  const cloudTokens = useMemo(() => tokenizeQuery(cloudQuery), [cloudQuery]);
  const tripTokens = useMemo(() => tokenizeQuery(tripQuery), [tripQuery]);

  const visibleCloudFiles = useMemo(() => {
    const files = cloudFolder?.files ?? [];
    if (cloudTokens.length === 0) return files;
    return files.filter((f) => matchesTokens(cloudTokens, [f.filename]));
  }, [cloudFolder, cloudTokens]);

  /**
   * A sheet matches on its own details or on any stop it carries, so typing an
   * invoice number answers "which driver has this one?" — the question being
   * asked when the phone rings, and the reason searching only the header would
   * be useless here.
   */
  const visibleTripSheets = useMemo(() => {
    if (tripTokens.length === 0) return tripSheets;
    return tripSheets.filter(
      (t) =>
        matchesTokens(tripTokens, [t.driverName, t.regNo, t.sourceFilename]) ||
        t.stops.some((s) =>
          matchesTokens(tripTokens, [s.invoiceNumber, s.customerName, s.address])
        )
    );
  }, [tripSheets, tripTokens]);

  const visibleCompletedSheets = useMemo(() => {
    if (tripTokens.length === 0) return completedSheets;
    return completedSheets.filter(
      (c) =>
        matchesTokens(tripTokens, [c.driverName, c.regNo, c.sourceFilename, c.archivedFile]) ||
        c.stops.some((s) =>
          matchesTokens(tripTokens, [s.invoiceNumber, s.customerName, s.address])
        )
    );
  }, [completedSheets, tripTokens]);

  /** Marks the stop that put its sheet in the list, inside an expanded sheet. */
  const stopMatchesQuery = (stop: {
    invoiceNumber: string;
    customerName: string;
    address?: string;
  }) =>
    tripTokens.length > 0 &&
    matchesTokens(tripTokens, [stop.invoiceNumber, stop.customerName, stop.address]);

  // Which pile the shared search box is counting against, so its readout
  // always describes the tab in front of it.
  const tripSearchTotal = tripTab === "active" ? tripSheets.length : completedSheets.length;
  const tripSearchMatches =
    tripTab === "active" ? visibleTripSheets.length : visibleCompletedSheets.length;

  /**
   * Completed sheets grouped into the days they were closed out on.
   *
   * Grouped in the browser rather than the API because `new Date(iso)` here is
   * already in the dispatcher's own timezone — the server would have to be told
   * the offset to reach the same answer.
   */
  const completedByDay = useMemo(() => {
    const groups = new Map<
      string,
      { key: string; label: string; sheets: CompletedTripSheet[]; deliveries: number }
    >();

    const dayKey = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
        d.getDate()
      ).padStart(2, "0")}`;

    // Derived from the window the API reported, not from the clock — reading
    // the clock during render is impure and can relabel rows on a stray
    // re-render.
    const todayStart = completedDayStart ? new Date(completedDayStart) : null;
    const today = todayStart ? dayKey(todayStart) : null;
    const yesterday = todayStart
      ? dayKey(new Date(todayStart.getTime() - 24 * 60 * 60 * 1000))
      : null;

    for (const sheet of visibleCompletedSheets) {
      const when = new Date(sheet.completedAt);
      const key = dayKey(when);

      const group = groups.get(key) ?? {
        key,
        label:
          key === today
            ? "Today"
            : key === yesterday
            ? "Yesterday"
            : when.toLocaleDateString("en-ZA", {
                weekday: "long",
                day: "2-digit",
                month: "short",
                year: "numeric",
              }),
        sheets: [] as CompletedTripSheet[],
        deliveries: 0,
      };

      group.sheets.push(sheet);
      group.deliveries += sheet.signedStops;
      groups.set(key, group);
    }

    // The API already returns newest first, so insertion order is date order.
    return [...groups.values()];
  }, [visibleCompletedSheets, completedDayStart]);

  // ─── File Upload ──────────────────────────────────────────────────────

  const handleFile = async (file: File) => {
    setError(null);
    setPreview(null);
    setUploadedFile(file);
    setUploading(true);
    setInvoiceUploads({});
    setInvoiceConflict(null);

    try {
      const formData = new FormData();
      formData.append("file", file);

      const res = await fetch("/api/trip-sheet", {
        method: "POST",
        body: formData,
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Upload failed");
        setUploadedFile(null);
      } else {
        setPreview(data);
        // Auto-select all already-signed invoices for skipping
        const signed = data.preview?.alreadySigned || [];
        setSkippedInvoices(new Set(signed.map((s: AlreadySignedInvoice) => s.invoiceNumber)));
      }
    } catch {
      setError("Failed to connect to server");
      setUploadedFile(null);
    } finally {
      setUploading(false);
    }
  };

  // ─── Missing Invoices ─────────────────────────────────────────────────

  /**
   * Re-run the preview against the invoice folder as it stands now.
   *
   * A newly uploaded PDF only becomes a match when the sheet is parsed again,
   * so this is what turns "No PDF" into a matched stop. Skip decisions are
   * carried over deliberately — only the invoice matching is being refreshed,
   * and re-seeding them from `alreadySigned` would silently undo the
   * dispatcher's choices.
   */
  const refreshPreview = async () => {
    if (!uploadedFile && !importSourceFile) return;
    setRecheckingInvoices(true);
    setError(null);

    try {
      let res: Response;
      if (uploadedFile) {
        const formData = new FormData();
        formData.append("file", uploadedFile);
        res = await fetch("/api/trip-sheet", { method: "POST", body: formData });
      } else {
        res = await fetch("/api/trip-sheet/folder", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filename: importSourceFile }),
        });
      }

      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Could not re-check the trip sheet");
        return;
      }

      setPreview(data);
      setInvoiceConflict(null);
      // Upload results are deliberately kept: a row that matched has gone from
      // the list, and its "saved" line is the only confirmation of where the
      // PDF went. They are cleared when a different sheet is previewed.
    } catch {
      setError("Failed to re-check invoices");
    } finally {
      setRecheckingInvoices(false);
    }
  };

  /**
   * Send one PDF to the invoice folder. `invoiceNumber` names the saved file
   * after the number on the sheet, which is what makes the re-check match it;
   * without one the file keeps its own name and matches on that instead.
   */
  const uploadInvoicePdf = async (
    file: File,
    opts: { invoiceNumber?: string; overwrite?: boolean } = {}
  ): Promise<boolean> => {
    const key = opts.invoiceNumber ?? file.name;
    setInvoiceUploads((prev) => ({ ...prev, [key]: { state: "uploading" } }));

    try {
      const formData = new FormData();
      formData.append("file", file);
      if (opts.invoiceNumber) formData.append("invoiceNumber", opts.invoiceNumber);
      if (opts.overwrite) formData.append("overwrite", "true");

      const res = await fetch("/api/invoices/upload", { method: "POST", body: formData });
      const data = await res.json();

      if (!res.ok) {
        if (res.status === 409 && data.conflict) {
          setInvoiceConflict({ key, file, invoiceNumber: opts.invoiceNumber });
        }
        setInvoiceUploads((prev) => ({
          ...prev,
          [key]: { state: "failed", message: data.error || "Upload failed" },
        }));
        return false;
      }

      if (data.location) setInvoiceDestination(data.location);
      setInvoiceUploads((prev) => ({
        ...prev,
        [key]: { state: "done", message: data.filename },
      }));
      return true;
    } catch {
      setInvoiceUploads((prev) => ({
        ...prev,
        [key]: { state: "failed", message: "Upload failed" },
      }));
      return false;
    }
  };

  const handleMissingInvoiceFile = async (file: File) => {
    const invoiceNumber = uploadTargetInvoice;
    setUploadTargetInvoice(null);
    if (!invoiceNumber) return;

    setInvoiceConflict(null);
    if (await uploadInvoicePdf(file, { invoiceNumber })) {
      await refreshPreview();
    }
  };

  /** Bulk add: each file keeps its own name and the re-parse does the matching. */
  const handleBulkInvoiceFiles = async (files: File[]) => {
    setInvoiceConflict(null);
    let anySaved = false;
    for (const file of files) {
      if (await uploadInvoicePdf(file)) anySaved = true;
    }
    if (anySaved) await refreshPreview();
  };

  const handleReplaceConflict = async () => {
    if (!invoiceConflict) return;
    const { file, invoiceNumber } = invoiceConflict;
    setInvoiceConflict(null);
    if (await uploadInvoicePdf(file, { invoiceNumber, overwrite: true })) {
      await refreshPreview();
    }
  };

  /**
   * The server refused the deploy because stops would have gone out with no
   * PDF behind them. Only reachable when this tab's view of the invoice folder
   * was stale, so re-preview to show what the server actually saw.
   */
  const handleMissingInvoiceRejection = async (message?: string) => {
    setError(
      `${message || "Some invoices have no PDF"}. Upload the PDFs, or skip those stops.`
    );
    await refreshPreview();
  };

  const handleDeploy = async () => {
    if (!uploadedFile && !importSourceFile) return;
    setDeploying(true);
    setError(null);

    try {
      // Cloud import deploy path
      if (importSourceFile && !uploadedFile) {
        const bodyPayload: Record<string, unknown> = {
          filename: importSourceFile,
          action: "deploy",
        };

        if (hasUnassigned && assignToDriverId) {
          const selectedDriver = drivers.find((d) => d.id === assignToDriverId);
          if (selectedDriver) {
            bodyPayload.assignTo = {
              driverId: selectedDriver.id,
              driverName: selectedDriver.name,
            };
          }
        }

        if (skippedInvoices.size > 0) {
          bodyPayload.skipInvoices = Array.from(skippedInvoices);
        }

        const res = await fetch("/api/trip-sheet/folder", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(bodyPayload),
        });
        const data = await res.json();

        if (res.status === 409 && data.code === "MISSING_INVOICES") {
          await handleMissingInvoiceRejection(data.error);
        } else if (!res.ok) {
          setError(data.error || "Deploy failed");
        } else {
          setPreview(null);
          setImportSourceFile(null);
          setAssignToDriverId("");
          setSkippedInvoices(new Set());
          setInvoiceUploads({});
          fetchTripSheets();
          fetchCloudFolder();
        }
      } else if (uploadedFile) {
        // Regular file upload deploy path
        const formData = new FormData();
        formData.append("file", uploadedFile);
        formData.append("action", "deploy");

        if (hasUnassigned && assignToDriverId) {
          const selectedDriver = drivers.find((d) => d.id === assignToDriverId);
          if (selectedDriver) {
            formData.append(
              "assignTo",
              JSON.stringify({
                driverId: selectedDriver.id,
                driverName: selectedDriver.name,
              })
            );
          }
        }

        if (skippedInvoices.size > 0) {
          formData.append("skipInvoices", JSON.stringify(Array.from(skippedInvoices)));
        }

        const res = await fetch("/api/trip-sheet", {
          method: "POST",
          body: formData,
        });
        const data = await res.json();

        if (res.status === 409 && data.code === "MISSING_INVOICES") {
          await handleMissingInvoiceRejection(data.error);
        } else if (!res.ok) {
          setError(data.error || "Deploy failed");
        } else {
          setPreview(null);
          setUploadedFile(null);
          setAssignToDriverId("");
          setSkippedInvoices(new Set());
          setInvoiceUploads({});
          fetchTripSheets();
        }
      }
    } catch {
      setError("Failed to deploy trip sheet");
    } finally {
      setDeploying(false);
    }
  };

  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

  const handleDelete = async (tripId: string) => {
    // Two-click pattern: first click sets pending, second click confirms
    if (pendingDeleteId !== tripId) {
      setPendingDeleteId(tripId);
      // Auto-clear after 4 seconds if not confirmed
      setTimeout(() => setPendingDeleteId((cur) => (cur === tripId ? null : cur)), 4000);
      return;
    }

    setPendingDeleteId(null);
    try {
      const res = await fetch("/api/trip-sheet", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: tripId }),
      });
      if (res.ok) {
        fetchTripSheets();
      } else {
        const data = await res.json();
        setError(data.error || "Failed to delete trip sheet");
      }
    } catch {
      setError("Failed to delete trip sheet");
    }
  };

  // ─── Cloud File Selection Helpers ─────────────────────────────────────
  const toggleCloudFile = (filename: string) => {
    setSelectedCloudFiles((prev) => {
      const next = new Set(prev);
      if (next.has(filename)) next.delete(filename);
      else next.add(filename);
      return next;
    });
  };

  const toggleAllCloudFiles = () => {
    if (!cloudFolder) return;
    // "All" means all of what the search left on screen. Reaching past the
    // query would hand a batch delete rows nobody can see.
    const allFilenames = visibleCloudFiles.map((f) => f.filename);
    if (selectedCloudFiles.size === allFilenames.length) {
      setSelectedCloudFiles(new Set());
    } else {
      setSelectedCloudFiles(new Set(allFilenames));
    }
  };

  const selectDuplicateCloudFiles = () => {
    if (!cloudFolder?.duplicates) return;
    const dupeFiles = new Set<string>();
    for (const group of cloudFolder.duplicates) {
      // Select all except the first (keep one, select the rest)
      for (let i = 1; i < group.filenames.length; i++) {
        dupeFiles.add(group.filenames[i]);
      }
    }
    // Show what was just selected: a live query would otherwise leave most of
    // it off screen while the action bar went on counting it.
    setCloudQuery("");
    setCloudPage(1);
    setSelectedCloudFiles(dupeFiles);
  };

  const handleBatchDeleteCloudFiles = async () => {
    if (selectedCloudFiles.size === 0) return;
    setDeletingCloudFiles(true);
    setError(null);
    try {
      const res = await fetch("/api/trip-sheet/folder", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filenames: Array.from(selectedCloudFiles) }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Failed to delete files");
      } else {
        setSelectedCloudFiles(new Set());
        fetchCloudFolder();
      }
    } catch {
      setError("Failed to delete files");
    } finally {
      setDeletingCloudFiles(false);
      setShowCloudDeleteConfirm(false);
    }
  };

  // ─── Active Trip Selection Helpers ────────────────────────────────────
  const toggleTrip = (tripId: string) => {
    setSelectedTrips((prev) => {
      const next = new Set(prev);
      if (next.has(tripId)) next.delete(tripId);
      else next.add(tripId);
      return next;
    });
  };

  const toggleAllTrips = () => {
    if (selectedTrips.size === visibleTripSheets.length) {
      setSelectedTrips(new Set());
    } else {
      setSelectedTrips(new Set(visibleTripSheets.map((t) => t.id)));
    }
  };

  /**
   * Narrowing a list drops its selection with it. Otherwise Complete Selected
   * or Delete Selected would still be holding sheets the query has since taken
   * off the screen, which is not what the count in the action bar implies.
   */
  const handleCloudQueryChange = (next: string) => {
    setCloudQuery(next);
    setCloudPage(1);
    setSelectedCloudFiles(new Set());
  };

  const handleTripQueryChange = (next: string) => {
    setTripQuery(next);
    setTripPage(1);
    setSelectedTrips(new Set());
  };

  const handleBatchDeleteTrips = async () => {
    if (selectedTrips.size === 0) return;
    setDeletingTrips(true);
    setError(null);
    try {
      const res = await fetch("/api/trip-sheet", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: Array.from(selectedTrips) }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Failed to delete trip sheets");
      } else {
        setSelectedTrips(new Set());
        fetchTripSheets();
      }
    } catch {
      setError("Failed to delete trip sheets");
    } finally {
      setDeletingTrips(false);
      setShowTripDeleteConfirm(false);
    }
  };

  // ─── Complete/Archive Trip Sheet Helpers ─────────────────────────────
  const handleCompleteSingle = async (tripId: string) => {
    setCompletingTripId(tripId);
    setError(null);
    setCompleteSuccess(null);
    try {
      const res = await fetch("/api/trip-sheet", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: tripId }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Failed to complete trip sheet");
      } else {
        const trip = tripSheets.find((t) => t.id === tripId);
        setCompleteSuccess(`Trip sheet for ${trip?.driverName || "driver"} archived successfully`);
        fetchTripSheets();
        fetchCompletedSheets();
        fetchCloudFolder();
        setTimeout(() => setCompleteSuccess(null), 4000);
      }
    } catch {
      setError("Failed to complete trip sheet");
    } finally {
      setCompletingTripId(null);
    }
  };

  const handleBatchCompleteTrips = async () => {
    if (selectedTrips.size === 0) return;
    setCompletingTrips(true);
    setError(null);
    setCompleteSuccess(null);
    try {
      const res = await fetch("/api/trip-sheet", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: Array.from(selectedTrips) }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Failed to complete trip sheets");
      } else {
        const failedCount = data.failed?.length || 0;
        const completedCount = data.completed || 0;
        if (failedCount > 0) {
          setError(`${failedCount} trip sheet(s) could not be completed: ${data.failed.map((f: { error: string }) => f.error).join(", ")}`);
        }
        if (completedCount > 0) {
          setCompleteSuccess(`${completedCount} trip sheet(s) archived successfully`);
          setTimeout(() => setCompleteSuccess(null), 4000);
        }
        setSelectedTrips(new Set());
        fetchTripSheets();
        fetchCompletedSheets();
        fetchCloudFolder();
      }
    } catch {
      setError("Failed to complete trip sheets");
    } finally {
      setCompletingTrips(false);
      setShowCompleteConfirm(false);
    }
  };

  // Check which selected trips are fully signed (completable)
  const selectedCompletableTrips = tripSheets.filter(
    (t) => selectedTrips.has(t.id) && t.stops.length > 0 && t.stops.every((s) => s.status === "SIGNED")
  );

  // Duplicate filename set for quick lookup
  const duplicateCloudFilenames = new Set<string>();
  if (cloudFolder?.duplicates) {
    for (const group of cloudFolder.duplicates) {
      for (const fn of group.filenames) {
        duplicateCloudFilenames.add(fn);
      }
    }
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragActive(false);
    const file = e.dataTransfer.files?.[0];
    if (file) handleFile(file);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setDragActive(true);
  };

  const handleDragLeave = () => {
    setDragActive(false);
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
    // Reset input so the same file can be re-selected
    e.target.value = "";
  };

  const formatDate = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleDateString("en-ZA", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  const hasUnassigned = preview?.preview.driverResults.some(
    (r) => r.driverId === "__unassigned__"
  );
  const assignedResults = preview?.preview.driverResults.filter(
    (r) => r.driverId !== "__unassigned__"
  );
  const unassignedResult = preview?.preview.driverResults.find(
    (r) => r.driverId === "__unassigned__"
  );
  const allStopsSkipped = preview && preview.preview.driverResults.every(
    (r) => r.stops.every((s) => skippedInvoices.has(s.invoiceNumber))
  );

  // Rows the sheet left unassigned are not deployed until a driver is picked,
  // so their missing PDFs are not yet anyone's problem. Mirrors the same rule
  // in collectMissingInvoices() on the server.
  const unassignedStopIds = useMemo(
    () => new Set(unassignedResult?.stops.map((s) => s.id) ?? []),
    [unassignedResult]
  );

  const missingInvoices = useMemo(
    () =>
      (preview?.preview.missingInvoices ?? []).filter(
        (m) => assignToDriverId || !unassignedStopIds.has(m.stopId)
      ),
    [preview, assignToDriverId, unassignedStopIds]
  );

  /** Still needs an answer: no PDF, not skipped. */
  const unresolvedMissing = useMemo(
    () => missingInvoices.filter((m) => !skippedInvoices.has(m.invoiceNumber)),
    [missingInvoices, skippedInvoices]
  );

  const missingBlocksDeploy = unresolvedMissing.length > 0;

  /** Upload results with no missing-invoice row of their own — bulk adds, and
   *  rows that have since matched and left the list. */
  const bulkUploadResults = useMemo(() => {
    const rowKeys = new Set(missingInvoices.map((m) => m.invoiceNumber));
    return Object.entries(invoiceUploads).filter(([key]) => !rowKeys.has(key));
  }, [invoiceUploads, missingInvoices]);

  return (
    <div className="animate-fade-in">
      <div className="flex items-start justify-between mb-8 gap-4">
        <div>
          <h1 className="font-mono text-2xl font-medium text-ink-black tracking-tight">
            Trip Sheet
          </h1>
          <p className="text-sm text-ink-muted mt-1">
            Manage trip sheets and deploy stops to drivers
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <a
            href="/api/trip-sheet/template"
            download
            className="flex items-center gap-2 px-4 py-2.5 font-mono text-sm font-medium rounded border border-ink-border text-ink-black bg-ink-card hover:bg-ink-surface hover:border-ink-muted-light transition-all"
            title="Download a blank .xlsx with the right columns and your driver names"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            Template
          </a>
          <button
            onClick={() => setShowUpload(!showUpload)}
            className={`flex items-center gap-2 px-4 py-2.5 font-mono text-sm font-medium rounded transition-all ${
              showUpload
                ? "bg-ink-black text-white hover:bg-ink-black/90"
                : "bg-ink-green text-white hover:bg-ink-green-hover active:scale-[0.98]"
            }`}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              {showUpload ? (
                <>
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </>
              ) : (
                <>
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="17 8 12 3 7 8" />
                  <line x1="12" y1="3" x2="12" y2="15" />
                </>
              )}
            </svg>
            {showUpload ? "Close" : "Upload Trip Sheet"}
          </button>
        </div>
      </div>

      {/* ─── Stats Bar ──────────────────────────────────────────────────── */}
      {stats && stats.totalStops > 0 && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6 stagger-children">
          <div className="bg-ink-card border border-ink-border rounded p-4">
            <p className="text-xs font-mono text-ink-muted uppercase tracking-wide mb-1">Total Stops</p>
            <p className="text-2xl font-mono font-medium text-ink-black">{stats.totalStops}</p>
          </div>
          <div className="bg-ink-card border border-ink-border rounded p-4">
            <p className="text-xs font-mono text-ink-muted uppercase tracking-wide mb-1">Signed</p>
            <p className="text-2xl font-mono font-medium text-ink-green">{stats.signed}</p>
          </div>
          <div className="bg-ink-card border border-ink-border rounded p-4">
            <p className="text-xs font-mono text-ink-muted uppercase tracking-wide mb-1">Pending</p>
            <p className="text-2xl font-mono font-medium text-ink-red">{stats.pending}</p>
          </div>
          <div className="bg-ink-card border border-ink-border rounded p-4">
            <p className="text-xs font-mono text-ink-muted uppercase tracking-wide mb-1">Drivers</p>
            <p className="text-2xl font-mono font-medium text-ink-amber">{stats.activeDrivers}</p>
          </div>
        </div>
      )}

      {/* ─── Trip Sheet Folder (Cloud) ──────────────────────────────────── */}
      {cloudFolder && cloudFolder.path && cloudFolder.accessible && !preview && (
        <div className="mb-6 bg-ink-card border border-ink-border rounded overflow-hidden">
          <div className="flex items-center justify-between px-5 py-3 border-b border-ink-border">
            <div className="flex items-center gap-2">
              <span className="text-base">{cloudFolder.cloud.icon}</span>
              <h3 className="font-mono text-sm font-medium text-ink-black">
                {cloudFolder.cloud.label} Folder
              </h3>
              {cloudFolder.newFiles > 0 && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-mono font-medium rounded-full bg-ink-green-dim text-ink-green border border-ink-green/20">
                  {cloudFolder.newFiles} new
                </span>
              )}
              {cloudFolder.duplicates && cloudFolder.duplicates.length > 0 && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-mono font-medium rounded-full bg-ink-amber-dim text-ink-amber border border-ink-amber/20">
                  {cloudFolder.duplicates.reduce((sum, g) => sum + g.filenames.length - 1, 0)} duplicates
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => {
                  setCloudLoading(true);
                  fetchCloudFolder().finally(() => setCloudLoading(false));
                }}
                disabled={cloudLoading}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono text-ink-muted hover:text-ink-black border border-ink-border rounded hover:border-ink-muted-light transition-all"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={cloudLoading ? "animate-spin" : ""}>
                  <polyline points="23 4 23 10 17 10" />
                  <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                </svg>
                {cloudLoading ? "Syncing…" : "Sync Now"}
              </button>
            </div>
          </div>

          {/* Duplicate warning banner */}
          {cloudFolder.duplicates && cloudFolder.duplicates.length > 0 && (
            <div className="flex items-center gap-3 px-5 py-2.5 bg-ink-amber-dim border-b border-ink-amber/20">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-ink-amber shrink-0">
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                <line x1="12" y1="9" x2="12" y2="13" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
              <p className="text-xs font-mono text-ink-amber flex-1">
                {cloudFolder.duplicates.length} duplicate group{cloudFolder.duplicates.length !== 1 ? "s" : ""} detected
              </p>
              <button
                onClick={selectDuplicateCloudFiles}
                className="flex items-center gap-1.5 px-3 py-1 text-[11px] font-mono font-medium text-ink-amber bg-white/60 border border-ink-amber/20 rounded hover:bg-white hover:border-ink-amber/40 transition-all"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="9 11 12 14 22 4" />
                  <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
                </svg>
                Select Duplicates
              </button>
            </div>
          )}

          {cloudFolder.files.length > 0 ? (
            <>
            {/* Select all row + search */}
            <div className="flex items-center gap-3 px-5 py-2 border-b border-ink-border bg-ink-surface/30 flex-wrap">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={visibleCloudFiles.length > 0 && selectedCloudFiles.size === visibleCloudFiles.length}
                  onChange={toggleAllCloudFiles}
                  className="w-3.5 h-3.5 rounded border-ink-border text-ink-green accent-[#00C07F] cursor-pointer"
                />
                <span className="text-[11px] font-mono text-ink-muted">
                  {selectedCloudFiles.size > 0 ? `${selectedCloudFiles.size} selected` : "Select all"}
                </span>
              </label>
              <FilterSearch
                value={cloudQuery}
                onChange={handleCloudQueryChange}
                placeholder="Search filename…"
                matchCount={visibleCloudFiles.length}
                totalCount={cloudFolder.files.length}
                noun="file"
                className="ml-auto"
              />
            </div>
            <div className="divide-y divide-ink-border">
              {visibleCloudFiles
                .slice((cloudPage - 1) * ITEMS_PER_PAGE, cloudPage * ITEMS_PER_PAGE)
                .map((file) => (
                <div
                  key={file.filename}
                  className={`flex items-center gap-3 px-5 py-3 hover:bg-ink-surface/50 transition-colors ${
                    duplicateCloudFilenames.has(file.filename) ? "bg-ink-amber-dim/30 border-l-2 border-l-ink-amber" : ""
                  } ${selectedCloudFiles.has(file.filename) ? "bg-ink-green-dim/20" : ""}`}
                >
                  {/* Checkbox */}
                  <input
                    type="checkbox"
                    checked={selectedCloudFiles.has(file.filename)}
                    onChange={() => toggleCloudFile(file.filename)}
                    className="w-3.5 h-3.5 rounded border-ink-border text-ink-green accent-[#00C07F] cursor-pointer shrink-0"
                  />

                  {/* File icon */}
                  <div className={`w-8 h-8 rounded flex items-center justify-center shrink-0 ${
                    file.imported ? "bg-ink-surface" : duplicateCloudFilenames.has(file.filename) ? "bg-ink-amber-dim" : "bg-ink-green-dim"
                  }`}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={file.imported ? "#888580" : duplicateCloudFilenames.has(file.filename) ? "#F59E0B" : "#00C07F"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                      <polyline points="14 2 14 8 20 8" />
                    </svg>
                  </div>

                  {/* File info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-mono text-ink-black truncate">
                        {file.filename}
                      </p>
                      {duplicateCloudFilenames.has(file.filename) && (
                        <span className="inline-flex items-center px-1.5 py-0.5 text-[9px] font-mono font-medium rounded bg-ink-amber-dim text-ink-amber border border-ink-amber/20 shrink-0">
                          DUPLICATE
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-ink-muted">
                      {(file.sizeBytes / 1024).toFixed(1)} KB · {file.extension.toUpperCase()} · Modified {new Date(file.lastModified).toLocaleDateString("en-ZA", { day: "2-digit", month: "short" })}
                    </p>
                  </div>

                  {/* Status / Action */}
                  {file.imported ? (
                    <span className="badge-signed text-[10px] shrink-0">
                      <span className="w-1.5 h-1.5 rounded-full bg-ink-green" />
                      Imported{file.importedAt ? ` ${new Date(file.importedAt).toLocaleDateString("en-ZA", { day: "2-digit", month: "short" })}` : ""}
                    </span>
                  ) : (
                    <button
                      onClick={async () => {
                        setCloudImporting(file.filename);
                        setError(null);
                        try {
                          const res = await fetch("/api/trip-sheet/folder", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ filename: file.filename }),
                          });
                          const data = await res.json();
                          if (!res.ok) {
                            setError(data.error || "Import failed");
                          } else {
                            setPreview(data);
                            setImportSourceFile(file.filename);
                            setUploadedFile(null);
                            // Auto-select all already-signed invoices for skipping
                            const signed = data.preview?.alreadySigned || [];
                            setSkippedInvoices(new Set(signed.map((s: AlreadySignedInvoice) => s.invoiceNumber)));
                            setInvoiceUploads({});
                            setInvoiceConflict(null);
                          }
                        } catch {
                          setError("Failed to import file");
                        } finally {
                          setCloudImporting(null);
                        }
                      }}
                      disabled={cloudImporting === file.filename}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono font-medium text-ink-green bg-ink-green-dim border border-ink-green/20 rounded hover:bg-ink-green hover:text-white transition-all shrink-0"
                    >
                      {cloudImporting === file.filename ? (
                        <>
                          <div className="w-3 h-3 border-2 border-ink-green/30 border-t-ink-green rounded-full animate-spin" />
                          Importing…
                        </>
                      ) : (
                        <>
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                            <polyline points="7 10 12 15 17 10" />
                            <line x1="12" y1="15" x2="12" y2="3" />
                          </svg>
                          Import
                        </>
                      )}
                    </button>
                  )}
                </div>
              ))}
              {visibleCloudFiles.length === 0 && (
                <div className="px-5 py-8 text-center">
                  <p className="text-sm font-mono text-ink-muted">
                    No file matches “{cloudQuery.trim()}”
                  </p>
                  <button
                    onClick={() => handleCloudQueryChange("")}
                    className="mt-3 px-3 py-1.5 text-xs font-mono text-ink-muted bg-ink-surface border border-ink-border rounded hover:text-ink-black hover:border-ink-black/30 transition-all"
                  >
                    Clear search
                  </button>
                </div>
              )}
            </div>

            {/* Selection action bar */}
            {selectedCloudFiles.size > 0 && (
              <div className="flex items-center justify-between px-5 py-2.5 border-t border-ink-border bg-ink-surface/50 animate-fade-in">
                <p className="text-xs font-mono text-ink-muted">
                  {selectedCloudFiles.size} file{selectedCloudFiles.size !== 1 ? "s" : ""} selected
                </p>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setSelectedCloudFiles(new Set())}
                    className="px-3 py-1.5 text-xs font-mono text-ink-muted hover:text-ink-black transition-colors"
                  >
                    Clear
                  </button>
                  <button
                    onClick={() => setShowCloudDeleteConfirm(true)}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono font-medium text-white bg-ink-red rounded hover:bg-red-600 transition-all"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="3 6 5 6 21 6" />
                      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                    </svg>
                    Delete Selected
                  </button>
                </div>
              </div>
            )}

            {/* Cloud files pagination */}
            {visibleCloudFiles.length > ITEMS_PER_PAGE && (() => {
              const totalCloudPages = Math.ceil(visibleCloudFiles.length / ITEMS_PER_PAGE);
              return (
                <div className="flex items-center justify-between px-5 py-2.5 border-t border-ink-border bg-ink-surface/30">
                  <p className="text-xs font-mono text-ink-muted">
                    {(cloudPage - 1) * ITEMS_PER_PAGE + 1}–{Math.min(cloudPage * ITEMS_PER_PAGE, visibleCloudFiles.length)} of {visibleCloudFiles.length}
                  </p>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => setCloudPage((p) => Math.max(1, p - 1))}
                      disabled={cloudPage === 1}
                      className="px-2 py-1 text-xs font-mono text-ink-muted hover:text-ink-black disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                    >
                      ‹ Prev
                    </button>
                    <span className="text-xs font-mono text-ink-muted">
                      {cloudPage}/{totalCloudPages}
                    </span>
                    <button
                      onClick={() => setCloudPage((p) => Math.min(totalCloudPages, p + 1))}
                      disabled={cloudPage === totalCloudPages}
                      className="px-2 py-1 text-xs font-mono text-ink-muted hover:text-ink-black disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                    >
                      Next ›
                    </button>
                  </div>
                </div>
              );
            })()}
            </>
          ) : (
            <div className="py-8 text-center">
              <p className="text-sm font-mono text-ink-muted">No trip sheet files found</p>
              <p className="text-xs text-ink-muted mt-1">
                Place .csv, .xlsx, or .xls files in your cloud folder
              </p>
            </div>
          )}

          {/* Folder path */}
          <div className="px-5 py-2 bg-ink-surface/50 border-t border-ink-border">
            <p className="text-[10px] font-mono text-ink-muted-light truncate">
              {cloudFolder.path}
              <span className="ml-2 opacity-60">· Auto-syncs every 30s</span>
            </p>
          </div>
        </div>
      )}

      {/* Cloud files delete confirmation modal */}
      {showCloudDeleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 animate-fade-in" onClick={() => setShowCloudDeleteConfirm(false)}>
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full mx-4 overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <div className="px-6 py-5">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 rounded-full bg-ink-red-dim flex items-center justify-center">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-ink-red">
                    <polyline points="3 6 5 6 21 6" />
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                  </svg>
                </div>
                <div>
                  <h3 className="font-mono text-sm font-medium text-ink-black">Delete {selectedCloudFiles.size} file{selectedCloudFiles.size !== 1 ? "s" : ""}?</h3>
                  <p className="text-xs text-ink-muted mt-0.5">This action cannot be undone</p>
                </div>
              </div>
              <p className="text-sm text-ink-muted mb-1">
                The following files will be <span className="font-medium text-ink-red">permanently removed</span> from the filesystem:
              </p>
              <div className="max-h-32 overflow-y-auto bg-ink-surface rounded p-2 mb-4">
                {Array.from(selectedCloudFiles).map((fn) => (
                  <p key={fn} className="text-xs font-mono text-ink-black py-0.5 truncate">{fn}</p>
                ))}
              </div>
            </div>
            <div className="flex justify-end gap-3 px-6 py-4 bg-ink-surface/50 border-t border-ink-border">
              <button
                onClick={() => setShowCloudDeleteConfirm(false)}
                className="px-4 py-2 text-sm font-mono text-ink-muted hover:text-ink-black transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleBatchDeleteCloudFiles}
                disabled={deletingCloudFiles}
                className="flex items-center gap-2 px-4 py-2 text-sm font-mono font-medium text-white bg-ink-red rounded hover:bg-red-600 transition-all disabled:opacity-50"
              >
                {deletingCloudFiles ? (
                  <>
                    <div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    Deleting…
                  </>
                ) : (
                  "Delete Permanently"
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── Upload Section (togglable) ──────────────────────────────────── */}
      {(showUpload || preview) && (
        <div className="space-y-4 mb-6 animate-fade-in">

      {/* ─── Upload Zone ────────────────────────────────────────────────── */}
      <div
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onClick={() => fileInputRef.current?.click()}
        className={`bg-ink-card border-2 border-dashed rounded p-10 text-center cursor-pointer transition-all ${
          dragActive
            ? "border-ink-green bg-ink-green-dim scale-[1.01]"
            : uploading
            ? "border-ink-amber bg-ink-amber-dim"
            : "border-ink-border hover:border-ink-muted-light hover:bg-ink-surface/50"
        }`}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv,.xlsx,.xls"
          onChange={handleInputChange}
          className="hidden"
          id="trip-sheet-upload"
        />

        {uploading ? (
          <>
            <div className="w-8 h-8 border-2 border-ink-border border-t-ink-green rounded-full animate-spin mx-auto mb-4" />
            <p className="font-mono text-sm font-medium text-ink-black">
              Analysing trip sheet…
            </p>
            <p className="text-xs text-ink-muted mt-1">
              Parsing rows, matching invoices and drivers
            </p>
          </>
        ) : (
          <>
            <div className="text-4xl mb-3">📋</div>
            <p className="font-mono text-sm font-medium text-ink-black">
              {dragActive
                ? "Drop trip sheet here"
                : "Drop trip sheet here or click to browse"}
            </p>
            <p className="text-xs text-ink-muted mt-2">
              Accepts CSV or Excel (.xlsx / .xls) — max 10MB
            </p>
            <div className="flex justify-center gap-2 mt-3">
              {["CSV", "XLSX"].map((fmt) => (
                <span
                  key={fmt}
                  className="px-2 py-0.5 bg-ink-surface text-ink-muted text-xs font-mono rounded"
                >
                  {fmt}
                </span>
              ))}
            </div>
            <p className="text-xs text-ink-muted mt-4">
              Not sure of the columns?{" "}
              {/* Inside a click-to-browse zone — the anchor must not also open the file picker. */}
              <a
                href="/api/trip-sheet/template"
                download
                onClick={(e) => e.stopPropagation()}
                className="text-ink-green font-medium underline underline-offset-2 hover:text-ink-green-hover"
              >
                Download the .xlsx template
              </a>
            </p>
          </>
        )}
      </div>

        </div>
      )}

      {/* ─── Error ──────────────────────────────────────────────────────── */}
      {error && (
        <div className="mt-4 flex items-center gap-2 px-4 py-3 bg-ink-red-dim rounded border border-ink-red/20 animate-fade-in">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-ink-red shrink-0">
            <circle cx="12" cy="12" r="10" />
            <line x1="15" y1="9" x2="9" y2="15" />
            <line x1="9" y1="9" x2="15" y2="15" />
          </svg>
          <span className="text-sm font-mono text-ink-red">{error}</span>
        </div>
      )}

      {/* ─── Preview Results ────────────────────────────────────────────── */}
      {preview && preview.preview && (
        <div className="mt-6 space-y-4 animate-fade-in">
          {/* Summary */}
          <div className="bg-ink-card border border-ink-border rounded p-5">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="font-mono text-sm font-medium text-ink-black">
                  Upload Preview
                </h3>
                <p className="text-xs text-ink-muted mt-0.5">
                  {uploadedFile?.name} — {preview.preview.totalRows} rows parsed
                </p>
              </div>
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-ink-green" />
                  <span className="text-xs font-mono text-ink-muted">
                    {preview.preview.matchedInvoices} matched
                  </span>
                </div>
                {preview.preview.unmatchedInvoices > 0 && (
                  <div className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-ink-amber" />
                    <span className="text-xs font-mono text-ink-muted">
                      {preview.preview.unmatchedInvoices} unmatched
                    </span>
                  </div>
                )}
                {(preview.preview.totalCollections ?? 0) > 0 && (
                  <div className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-ink-violet" />
                    <span
                      className="text-xs font-mono text-ink-muted"
                      title={
                        (preview.preview.unmatchedCollections ?? 0) > 0
                          ? `${preview.preview.unmatchedCollections} have no document in the collections Pending folder yet. They still deploy — the driver signs a generated receipt.`
                          : "Every collection has a matching document"
                      }
                    >
                      {preview.preview.totalCollections} collection
                      {preview.preview.totalCollections === 1 ? "" : "s"}
                      {(preview.preview.unmatchedCollections ?? 0) > 0
                        ? ` (${preview.preview.unmatchedCollections} without a document)`
                        : ""}
                    </span>
                  </div>
                )}
              </div>
            </div>

            {/* A missing collection document is a note, not a blocker. The
                missing-INVOICE gate below is the hard one: the signature is
                embedded on the invoice, so a delivery without one leaves no
                physical record. A collection with no document still gets a
                receipt, generated at signing. */}
            {(preview.preview.unmatchedCollections ?? 0) > 0 && (
              <div className="mb-4 flex items-start gap-3 px-4 py-3 rounded border border-ink-violet/20 bg-ink-violet-dim">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-ink-violet shrink-0 mt-0.5">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="16" x2="12" y2="12" />
                  <line x1="12" y1="8" x2="12.01" y2="8" />
                </svg>
                <div>
                  <p className="text-xs font-mono text-ink-violet">
                    {preview.preview.unmatchedCollections} collection
                    {preview.preview.unmatchedCollections === 1 ? " has" : "s have"} no document
                    in the collections Pending folder
                  </p>
                  <p className="text-[11px] text-ink-muted mt-0.5">
                    This does not block the deploy. The driver captures the signature on a
                    receipt Signex generates, which is filed in the Signed folder either way.
                  </p>
                </div>
              </div>
            )}

            {/* Already-signed warning */}
            {preview.preview.alreadySigned && preview.preview.alreadySigned.length > 0 && (
              <div className="mb-4 border border-ink-red/30 rounded overflow-hidden">
                <div className="flex items-start gap-3 px-4 py-3 bg-ink-red/5">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-ink-red shrink-0 mt-0.5">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="8" x2="12" y2="12" />
                    <line x1="12" y1="16" x2="12.01" y2="16" />
                  </svg>
                  <div className="flex-1">
                    <p className="text-sm font-medium text-ink-black">
                      {preview.preview.alreadySigned.length} invoice{preview.preview.alreadySigned.length !== 1 ? "s" : ""} already signed
                    </p>
                    <p className="text-xs text-ink-muted mt-0.5">
                      These invoices were previously signed. They will be skipped by default — uncheck to include them anyway.
                    </p>
                  </div>
                  <button
                    onClick={() => {
                      if (skippedInvoices.size === preview.preview.alreadySigned.length) {
                        setSkippedInvoices(new Set());
                      } else {
                        setSkippedInvoices(new Set(preview.preview.alreadySigned.map((s) => s.invoiceNumber)));
                      }
                    }}
                    className="text-xs font-mono text-ink-muted hover:text-ink-black transition-colors whitespace-nowrap"
                  >
                    {skippedInvoices.size === preview.preview.alreadySigned.length ? "Include all" : "Skip all"}
                  </button>
                </div>
                <div className="divide-y divide-ink-border">
                  {preview.preview.alreadySigned.map((inv) => (
                    <label
                      key={inv.invoiceNumber}
                      className="flex items-center gap-3 px-4 py-2.5 text-xs hover:bg-ink-surface/30 cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={skippedInvoices.has(inv.invoiceNumber)}
                        onChange={() => {
                          setSkippedInvoices((prev) => {
                            const next = new Set(prev);
                            if (next.has(inv.invoiceNumber)) next.delete(inv.invoiceNumber);
                            else next.add(inv.invoiceNumber);
                            return next;
                          });
                        }}
                        className="w-3.5 h-3.5 rounded border-ink-border text-ink-red focus:ring-ink-red/30"
                      />
                      <span className="font-mono font-medium text-ink-black min-w-[100px]">
                        {inv.invoiceNumber}
                      </span>
                      <span className="text-ink-muted flex-1">
                        {inv.driverName ? `Signed by ${inv.driverName}` : "Signed"}
                        {inv.signedAt && ` on ${new Date(inv.signedAt).toLocaleDateString("en-ZA", { day: "2-digit", month: "short", year: "numeric" })}`}
                      </span>
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono bg-ink-red/10 text-ink-red">
                        {inv.source === "database" ? "DB" : "File"}
                      </span>
                      {skippedInvoices.has(inv.invoiceNumber) && (
                        <span className="text-ink-red font-mono">skip</span>
                      )}
                    </label>
                  ))}
                </div>
              </div>
            )}

            {/* Missing invoices — upload the PDF, or skip the stop.
                The hidden pickers below are shared by every row; the row that
                opened one is remembered in uploadTargetInvoice. */}
            <input
              ref={missingFileInputRef}
              type="file"
              accept="application/pdf,.pdf"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                // Cleared so picking the same file twice still fires onChange.
                e.target.value = "";
                if (file) handleMissingInvoiceFile(file);
              }}
            />
            <input
              ref={bulkInvoiceInputRef}
              type="file"
              accept="application/pdf,.pdf"
              multiple
              className="hidden"
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                e.target.value = "";
                if (files.length > 0) handleBulkInvoiceFiles(files);
              }}
            />

            {missingInvoices.length > 0 && (
              <div className="mb-4 border border-ink-amber/40 rounded overflow-hidden">
                <div className="flex items-start gap-3 px-4 py-3 bg-ink-amber-dim">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-ink-amber shrink-0 mt-0.5">
                    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                    <line x1="12" y1="9" x2="12" y2="13" />
                    <line x1="12" y1="17" x2="12.01" y2="17" />
                  </svg>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-ink-black">
                      {unresolvedMissing.length > 0
                        ? `${unresolvedMissing.length} invoice${unresolvedMissing.length !== 1 ? "s are" : " is"} not in the invoice folder`
                        : `All ${missingInvoices.length} missing invoice${missingInvoices.length !== 1 ? "s" : ""} accounted for`}
                    </p>
                    <p className="text-xs text-ink-muted mt-0.5">
                      Upload the PDF, or skip the stop.
                      {invoiceDestination && (
                        <>
                          {" "}Uploads are saved to{" "}
                          <span className="font-mono break-all">{invoiceDestination}</span>.
                        </>
                      )}
                    </p>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <button
                      onClick={() => bulkInvoiceInputRef.current?.click()}
                      disabled={recheckingInvoices}
                      className="text-xs font-mono text-ink-muted hover:text-ink-black transition-colors disabled:opacity-50 whitespace-nowrap"
                      title="Add PDFs keeping their own filenames — the re-check matches them"
                    >
                      Add PDFs…
                    </button>
                    <button
                      onClick={refreshPreview}
                      disabled={recheckingInvoices}
                      className="text-xs font-mono text-ink-muted hover:text-ink-black transition-colors disabled:opacity-50 whitespace-nowrap"
                    >
                      {recheckingInvoices ? "Checking…" : "Re-check"}
                    </button>
                    <button
                      onClick={() => {
                        setSkippedInvoices((prev) => {
                          const next = new Set(prev);
                          if (unresolvedMissing.length === 0) {
                            for (const m of missingInvoices) next.delete(m.invoiceNumber);
                          } else {
                            for (const m of missingInvoices) next.add(m.invoiceNumber);
                          }
                          return next;
                        });
                      }}
                      className="text-xs font-mono text-ink-muted hover:text-ink-black transition-colors whitespace-nowrap"
                    >
                      {unresolvedMissing.length === 0 ? "Include all" : "Skip all"}
                    </button>
                  </div>
                </div>
                <div className="divide-y divide-ink-border">
                  {missingInvoices.map((inv) => {
                    const upload = invoiceUploads[inv.invoiceNumber];
                    const isSkipped = skippedInvoices.has(inv.invoiceNumber);
                    const hasConflict = invoiceConflict?.key === inv.invoiceNumber;
                    return (
                      <div
                        key={inv.stopId}
                        className={`flex items-center gap-3 px-4 py-2.5 text-xs ${isSkipped ? "opacity-60" : ""}`}
                      >
                        <span className="font-mono font-medium text-ink-black min-w-[100px]">
                          {inv.invoiceNumber}
                        </span>
                        <span className="text-ink-muted truncate flex-1">
                          {inv.customerName}
                          <span className="text-ink-muted-light"> · {inv.driverName}</span>
                        </span>

                        {upload?.state === "failed" && (
                          <span className="text-ink-red truncate max-w-[220px]" title={upload.message}>
                            {upload.message}
                          </span>
                        )}
                        {hasConflict && (
                          <button
                            onClick={handleReplaceConflict}
                            className="px-2 py-0.5 rounded text-[10px] font-mono font-medium bg-ink-red/10 text-ink-red hover:bg-ink-red/20 transition-colors"
                          >
                            Replace
                          </button>
                        )}

                        <button
                          onClick={() => {
                            setUploadTargetInvoice(inv.invoiceNumber);
                            missingFileInputRef.current?.click();
                          }}
                          disabled={upload?.state === "uploading" || recheckingInvoices}
                          className="flex items-center gap-1 px-2 py-1 rounded border border-ink-border font-mono text-[10px] font-medium text-ink-black hover:bg-ink-surface transition-colors disabled:opacity-50 whitespace-nowrap"
                        >
                          {upload?.state === "uploading" ? (
                            <>
                              <span className="w-3 h-3 border-2 border-ink-muted/30 border-t-ink-muted rounded-full animate-spin" />
                              Uploading…
                            </>
                          ) : (
                            <>
                              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                                <polyline points="17 8 12 3 7 8" />
                                <line x1="12" y1="3" x2="12" y2="15" />
                              </svg>
                              Upload PDF
                            </>
                          )}
                        </button>

                        <label className="flex items-center gap-1.5 cursor-pointer text-ink-muted hover:text-ink-black transition-colors">
                          <input
                            type="checkbox"
                            checked={isSkipped}
                            onChange={() => {
                              setSkippedInvoices((prev) => {
                                const next = new Set(prev);
                                if (next.has(inv.invoiceNumber)) next.delete(inv.invoiceNumber);
                                else next.add(inv.invoiceNumber);
                                return next;
                              });
                            }}
                            className="w-3.5 h-3.5 rounded border-ink-border text-ink-amber focus:ring-ink-amber/30"
                          />
                          <span className="font-mono">Skip</span>
                        </label>
                      </div>
                    );
                  })}
                </div>

                {/* Files added by name rather than against a row — a bulk add
                    that matched nothing still needs to report itself. */}
                {bulkUploadResults.length > 0 && (
                  <div className="px-4 py-2 border-t border-ink-border bg-ink-surface/30 space-y-1">
                    {bulkUploadResults.map(([name, result]) => (
                      <p key={name} className="text-[11px] font-mono flex items-center gap-2">
                        <span className="text-ink-muted truncate max-w-[240px]">{name}</span>
                        <span
                          className={
                            result.state === "done"
                              ? "text-ink-green"
                              : result.state === "failed"
                                ? "text-ink-red"
                                : "text-ink-muted"
                          }
                        >
                          {result.state === "done"
                            ? "saved"
                            : result.state === "failed"
                              ? result.message || "failed"
                              : "uploading…"}
                        </span>
                      </p>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Driver breakdown */}
            {assignedResults && assignedResults.length > 0 && (
              <div className="space-y-3">
                {assignedResults.map((result) => (
                  <div
                    key={result.driverId}
                    className="border border-ink-border rounded overflow-hidden"
                  >
                    <div className="flex items-center gap-3 px-4 py-3 bg-ink-surface/50">
                      <div className="w-8 h-8 rounded bg-ink-green-dim flex items-center justify-center">
                        <span className="text-xs font-mono font-medium text-ink-green">
                          {result.driverName
                            .split(" ")
                            .map((n) => n[0])
                            .join("")}
                        </span>
                      </div>
                      <div className="flex-1">
                        <p className="text-sm font-medium text-ink-black">
                          {result.driverName}
                        </p>
                        <p className="text-xs text-ink-muted font-mono">
                          {result.regNo || "No REGNO"} · {result.stops.filter((s) => !skippedInvoices.has(s.invoiceNumber)).length} stop{result.stops.filter((s) => !skippedInvoices.has(s.invoiceNumber)).length !== 1 ? "s" : ""}
                          {result.stops.some((s) => skippedInvoices.has(s.invoiceNumber)) && (
                            <span className="text-ink-red ml-1">({result.stops.filter((s) => skippedInvoices.has(s.invoiceNumber)).length} skipped)</span>
                          )}
                        </p>
                      </div>
                      <span className="badge-signed">
                        <span className="w-1.5 h-1.5 rounded-full bg-ink-green" />
                        Matched
                      </span>
                    </div>
                    {/* Stop details */}
                    <div className="divide-y divide-ink-border">
                      {result.stops.map((stop) => {
                        const isSkipped = skippedInvoices.has(stop.invoiceNumber);
                        return (
                        <div
                          key={stop.id}
                          className={`flex items-center gap-3 px-4 py-2.5 text-xs ${isSkipped ? "opacity-40 line-through" : ""}`}
                        >
                          <span className="w-6 h-6 rounded bg-ink-surface flex items-center justify-center font-mono text-ink-muted font-medium shrink-0">
                            {stop.stopNumber}
                          </span>
                          <span className="font-mono font-medium text-ink-black min-w-[100px]">
                            {stop.invoiceNumber}
                          </span>
                          <span className="text-ink-muted truncate flex-1">
                            {stop.customerName}
                          </span>
                          {isSkipped ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono font-medium bg-ink-red/10 text-ink-red no-underline">
                              Skipped
                            </span>
                          ) : (
                            <>
                              {stop.nop > 0 && (
                                <span className="text-ink-muted font-mono">
                                  {stop.nop} pcs
                                </span>
                              )}
                              {stop.invoiceFile ? (
                                <span className="flex items-center gap-1 text-ink-green">
                                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                    <polyline points="20 6 9 17 4 12" />
                                  </svg>
                                  PDF
                                </span>
                              ) : (
                                <span className="flex items-center gap-1 text-ink-amber">
                                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                                    <line x1="12" y1="9" x2="12" y2="13" />
                                    <line x1="12" y1="17" x2="12.01" y2="17" />
                                  </svg>
                                  No PDF
                                </span>
                              )}
                            </>
                          )}
                        </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Unassigned rows — assign to driver */}
            {hasUnassigned && unassignedResult && (
              <div className="mt-4 border border-ink-amber/30 rounded overflow-hidden">
                <div className="flex items-start gap-3 px-4 py-3 bg-ink-amber-dim">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-ink-amber shrink-0 mt-0.5">
                    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                    <line x1="12" y1="9" x2="12" y2="13" />
                    <line x1="12" y1="17" x2="12.01" y2="17" />
                  </svg>
                  <div className="flex-1">
                    <p className="text-sm font-medium text-ink-black">
                      {unassignedResult.stops.filter((s) => !skippedInvoices.has(s.invoiceNumber)).length} stop{unassignedResult.stops.filter((s) => !skippedInvoices.has(s.invoiceNumber)).length !== 1 ? "s" : ""} need a driver
                    </p>
                    <p className="text-xs text-ink-muted mb-3">
                      No driver column found in the file. Select a driver to assign these stops to:
                    </p>
                    <select
                      value={assignToDriverId}
                      onChange={(e) => setAssignToDriverId(e.target.value)}
                      className="w-full max-w-sm px-3 py-2 text-sm font-mono bg-white border border-ink-border rounded focus:outline-none focus:border-ink-green transition-colors"
                    >
                      <option value="">— Select a driver —</option>
                      {drivers.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.name}
                        </option>
                      ))}
                    </select>
                    {assignToDriverId && (
                      <p className="text-xs text-ink-green mt-2 flex items-center gap-1">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                        All {unassignedResult.stops.length} stops will be assigned to {drivers.find(d => d.id === assignToDriverId)?.name}
                      </p>
                    )}
                  </div>
                </div>
                <div className="divide-y divide-ink-border">
                  {unassignedResult.stops.map((stop) => {
                    const isSkipped = skippedInvoices.has(stop.invoiceNumber);
                    return (
                    <div
                      key={stop.id}
                      className={`flex items-center gap-3 px-4 py-2.5 text-xs ${isSkipped ? "opacity-40 line-through" : ""}`}
                    >
                      <span className="w-6 h-6 rounded bg-ink-surface flex items-center justify-center font-mono text-ink-muted font-medium shrink-0">
                        {stop.stopNumber}
                      </span>
                      <span className="font-mono font-medium text-ink-black min-w-[100px]">
                        {stop.invoiceNumber}
                      </span>
                      <span className="text-ink-muted truncate flex-1">
                        {stop.customerName}
                      </span>
                      {isSkipped ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono font-medium bg-ink-red/10 text-ink-red no-underline">
                          Skipped
                        </span>
                      ) : assignToDriverId ? (
                        <span className="badge-signed">
                          <span className="w-1.5 h-1.5 rounded-full bg-ink-green" />
                          Assigned
                        </span>
                      ) : (
                        <span className="badge-pending">
                          <span className="w-1.5 h-1.5 rounded-full bg-ink-red" />
                          No driver
                        </span>
                      )}
                    </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {/* All stops skipped — prompt to upload new trip sheet */}
          {allStopsSkipped && (
            <div className="border border-ink-amber/30 rounded p-4 bg-ink-amber-dim flex items-start gap-3">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-ink-amber shrink-0 mt-0.5">
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                <line x1="12" y1="9" x2="12" y2="13" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
              <div>
                <p className="text-sm font-medium text-ink-black">
                  Every stop on this trip sheet is being skipped
                </p>
                <p className="text-xs text-ink-muted mt-1">
                  {missingInvoices.length > 0
                    ? "Nothing is left to deploy. Uncheck a stop and upload its invoice, or upload a new trip sheet."
                    : "There are no remaining stops to deploy. Please upload a new trip sheet."}
                </p>
              </div>
            </div>
          )}

          {/* Unresolved missing invoices block the deploy outright. The PDF is
              the physical record the signature is embedded on, so a stop with
              no invoice has nothing to leave behind. The server enforces the
              same rule against a fresh listing of the folder. */}
          {unresolvedMissing.length > 0 && !allStopsSkipped && (
            <div className="border border-ink-red/30 rounded p-4 bg-ink-red/5 flex items-start gap-3">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-ink-red shrink-0 mt-0.5">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
              <div className="flex-1">
                <p className="text-sm font-medium text-ink-black">
                  {unresolvedMissing.length} stop{unresolvedMissing.length !== 1 ? "s have" : " has"} no invoice PDF — deploy is blocked
                </p>
                <p className="text-xs text-ink-muted mt-1">
                  The signature is embedded on the invoice, so a stop without one
                  leaves no physical record of the delivery. Upload the missing
                  PDFs above, or skip those stops to leave them off this run.
                </p>
              </div>
            </div>
          )}

          {/* Deploy / Cancel actions */}
          <div className="flex items-center justify-end gap-3">
            <button
              onClick={() => {
                setPreview(null);
                setUploadedFile(null);
                setImportSourceFile(null);
                setSkippedInvoices(new Set());
                setInvoiceUploads({});
                setInvoiceConflict(null);
                setError(null);
              }}
              className="px-5 py-2.5 text-sm font-mono text-ink-muted hover:text-ink-black transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleDeploy}
              disabled={
                deploying ||
                recheckingInvoices ||
                missingBlocksDeploy ||
                allStopsSkipped ||
                ((!assignedResults || assignedResults.length === 0) && !assignToDriverId)
              }
              className="flex items-center gap-2 px-6 py-2.5 bg-ink-green text-white font-mono text-sm font-medium rounded hover:bg-ink-green-hover active:scale-[0.98] transition-all disabled:opacity-50"
            >
              {deploying ? (
                <>
                  <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  Deploying…
                </>
              ) : (
                <>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                  Deploy to Drivers
                </>
              )}
            </button>
          </div>
        </div>
      )}

      {/* ─── Trip Sheets: Active / Completed ────────────────────────────── */}
      {!preview && !loading && (
        <div className="mt-8 bg-ink-card border border-ink-border rounded overflow-hidden">
          {/* Tab bar. Completed sheets come from the archive rather than from
              live trip sheets — closing one out deletes it, which is why the
              day's work needs somewhere else to live. */}
          <div className="flex items-center justify-between border-b border-ink-border">
            <div className="flex items-center overflow-x-auto">
              {([
                { id: "active" as const, label: "Active Trip Sheets", count: tripSheets.length },
                {
                  id: "completed" as const,
                  label: completedRange === "today" ? "Completed Today" : "All Completed",
                  count: completedSheets.length,
                },
              ]).map((t) => (
                <button
                  key={t.id}
                  onClick={() => {
                    setTripTab(t.id);
                    setShowActiveTrips(true);
                  }}
                  className={`flex items-center gap-2 px-5 py-4 font-mono text-[13px] sm:text-sm font-medium uppercase tracking-wide whitespace-nowrap border-b-2 -mb-px transition-colors ${
                    tripTab === t.id
                      ? "border-ink-green text-ink-black"
                      : "border-transparent text-ink-muted hover:text-ink-black"
                  }`}
                >
                  {t.label}
                  <span className="inline-flex items-center px-2 py-0.5 text-[10px] font-mono font-medium rounded-full bg-ink-surface text-ink-muted">
                    {t.count}
                  </span>
                </button>
              ))}
            </div>
            <button
              onClick={() => setShowActiveTrips(!showActiveTrips)}
              className="px-5 py-4 text-ink-muted hover:text-ink-black transition-colors shrink-0"
              title={showActiveTrips ? "Collapse" : "Expand"}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className={`transition-transform ${showActiveTrips ? "rotate-180" : ""}`}
              >
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
          </div>

          {/* Search row. One box serving both tabs, so a driver's name typed
              against the live sheets survives the switch into the archive. */}
          {showActiveTrips && (tripSearchTotal > 0 || tripTokens.length > 0) && (
            <div className="px-4 py-2.5 border-b border-ink-border bg-ink-surface/30">
              <FilterSearch
                value={tripQuery}
                onChange={handleTripQueryChange}
                placeholder="Search driver, vehicle, file or invoice…"
                matchCount={tripSearchMatches}
                totalCount={tripSearchTotal}
                noun="sheet"
                shortcut
              />
            </div>
          )}

          {showActiveTrips && tripTab === "active" && tripSheets.length === 0 && (
            <div className="p-8 text-center">
              <p className="text-sm text-ink-muted font-mono">No active trip sheets</p>
              <p className="text-xs text-ink-muted mt-1">
                Upload a file above to preview and deploy stops to drivers
              </p>
            </div>
          )}

          {showActiveTrips && tripTab === "active" && tripSheets.length > 0 && (
          <div className="space-y-3 p-4 pt-0 stagger-children">
            {/* Select all */}
            <div className="flex items-center gap-3 py-2">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={visibleTripSheets.length > 0 && selectedTrips.size === visibleTripSheets.length}
                  onChange={toggleAllTrips}
                  className="w-4 h-4 rounded border-ink-border text-ink-green accent-[#00C07F] cursor-pointer"
                />
                <span className="text-[12px] sm:text-[11px] font-mono text-ink-muted">
                  {selectedTrips.size > 0 ? `${selectedTrips.size} selected` : "Select all"}
                </span>
              </label>
              {selectedTrips.size > 0 && (
                <div className="flex items-center gap-2 ml-auto">
                  <button
                    onClick={() => setSelectedTrips(new Set())}
                    className="px-3 py-1 text-xs font-mono text-ink-muted hover:text-ink-black transition-colors"
                  >
                    Clear
                  </button>
                  {selectedCompletableTrips.length > 0 && (
                    <button
                      onClick={() => setShowCompleteConfirm(true)}
                      className="flex items-center gap-1.5 px-3 py-1 text-xs font-mono font-medium text-white bg-ink-green rounded hover:bg-ink-green-hover transition-all"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                      Complete {selectedCompletableTrips.length === selectedTrips.size ? "Selected" : `${selectedCompletableTrips.length} Signed`}
                    </button>
                  )}
                  <button
                    onClick={() => setShowTripDeleteConfirm(true)}
                    className="flex items-center gap-1.5 px-3 py-1 text-xs font-mono font-medium text-white bg-ink-red rounded hover:bg-red-600 transition-all"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="3 6 5 6 21 6" />
                      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                    </svg>
                    Delete Selected
                  </button>
                </div>
              )}
            </div>
            {(() => {
              const totalTripPages = Math.ceil(visibleTripSheets.length / ITEMS_PER_PAGE);
              const paginatedTrips = visibleTripSheets.slice(
                (tripPage - 1) * ITEMS_PER_PAGE,
                tripPage * ITEMS_PER_PAGE
              );
              return (
                <>
            {paginatedTrips.map((trip) => {
              const signed = trip.stops.filter((s) => s.status === "SIGNED").length;
              const total = trip.stops.length;
              const pct = total > 0 ? Math.round((signed / total) * 100) : 0;
              // A trip cannot be closed out until its collections have outcomes
              // too, so the dispatcher needs to see them here rather than
              // discovering them in the error when Archive is pressed.
              const tripCollections = trip.stops.flatMap((s) => s.collections ?? []);
              const collectionsDone = tripCollections.filter(
                (c) => c.status !== "PENDING"
              ).length;
              const collectionExceptions = tripCollections.filter((c) =>
                COLLECTION_EXCEPTIONS.has(c.status)
              ).length;
              const isExpanded = expandedTrip === trip.id;
              // How much of this sheet the query actually hit. A sheet can be
              // in the list on the strength of one stop out of forty, and the
              // header is where that gets said without opening it.
              const stopHits =
                tripTokens.length > 0 ? trip.stops.filter(stopMatchesQuery).length : 0;

              return (
                <div
                  key={trip.id}
                  className="bg-ink-card border border-ink-border rounded overflow-hidden"
                >
                  {/* Trip header */}
                  <div
                    className={`flex items-center gap-3 px-5 py-4 cursor-pointer hover:bg-ink-surface/50 transition-colors ${selectedTrips.has(trip.id) ? "bg-ink-green-dim/20" : ""}`}
                    onClick={() => setExpandedTrip(isExpanded ? null : trip.id)}
                  >
                    {/* Checkbox */}
                    <input
                      type="checkbox"
                      checked={selectedTrips.has(trip.id)}
                      onChange={() => toggleTrip(trip.id)}
                      onClick={(e) => e.stopPropagation()}
                      className="w-3.5 h-3.5 rounded border-ink-border text-ink-green accent-[#00C07F] cursor-pointer shrink-0"
                    />
                    <div className="w-9 h-9 rounded bg-ink-green-dim flex items-center justify-center shrink-0">
                      <span className="text-xs font-mono font-medium text-ink-green">
                        {trip.driverName
                          .split(" ")
                          .map((n) => n[0])
                          .join("")}
                      </span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-[15px] sm:text-sm font-medium text-ink-black">
                          {trip.driverName}
                        </p>
                        {trip.status === "QUEUED" && (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-mono font-medium rounded bg-ink-surface text-ink-muted border border-ink-border">
                            QUEUED
                          </span>
                        )}
                        <span className="text-[12px] sm:text-xs font-mono text-ink-muted">
                          {trip.regNo}
                        </span>
                        {tripCollections.length > 0 && (
                          <span
                            className="badge-credit"
                            title={`${collectionsDone} of ${tripCollections.length} collections have an outcome. All of them need one before this sheet can be archived.`}
                          >
                            {collectionsDone}/{tripCollections.length} collected
                          </span>
                        )}
                        {collectionExceptions > 0 && (
                          <span
                            className="inline-flex items-center px-1.5 py-0.5 text-[10px] font-mono rounded bg-ink-amber-dim text-ink-amber border border-ink-amber/20"
                            title="Partial, unavailable or refused — accounts needs to look at these before raising a credit"
                          >
                            {collectionExceptions} EXCEPTION{collectionExceptions !== 1 ? "S" : ""}
                          </span>
                        )}
                        {stopHits > 0 && (
                          <span className="inline-flex items-center px-1.5 py-0.5 text-[10px] font-mono font-medium rounded bg-ink-green-dim text-ink-green border border-ink-green/20">
                            {stopHits} stop{stopHits !== 1 ? "s" : ""} match
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-3 mt-1">
                        <div className="flex-1 h-1.5 bg-ink-surface rounded-full overflow-hidden max-w-[200px]">
                          <div
                            className="h-full bg-ink-green rounded-full transition-all duration-500"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        <span className="text-[12px] sm:text-xs font-mono text-ink-muted">
                          {signed}/{total} signed
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {/* Complete/Archive button — only for fully signed trips */}
                      {pct === 100 && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleCompleteSingle(trip.id);
                          }}
                          disabled={completingTripId === trip.id}
                          className="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-mono font-medium bg-ink-green-dim text-ink-green border border-ink-green/20 hover:bg-ink-green hover:text-white transition-all disabled:opacity-50"
                          title="Archive completed trip sheet"
                        >
                          {completingTripId === trip.id ? (
                            <>
                              <div className="w-3 h-3 border-2 border-ink-green/30 border-t-ink-green rounded-full animate-spin" />
                              Archiving…
                            </>
                          ) : (
                            <>
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                <polyline points="20 6 9 17 4 12" />
                              </svg>
                              Complete
                            </>
                          )}
                        </button>
                      )}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDelete(trip.id);
                        }}
                        className={`flex items-center gap-1.5 px-2 py-1 rounded text-xs font-mono transition-all ${
                          pendingDeleteId === trip.id
                            ? "bg-ink-red text-white animate-pulse"
                            : "hover:bg-ink-red-dim text-ink-muted hover:text-ink-red"
                        }`}
                        title={pendingDeleteId === trip.id ? "Click again to confirm" : "Remove trip sheet"}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="3 6 5 6 21 6" />
                          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                        </svg>
                        {pendingDeleteId === trip.id && "Confirm?"}
                      </button>
                      {pendingDeleteId === trip.id && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setPendingDeleteId(null);
                          }}
                          className="text-xs font-mono text-ink-muted hover:text-ink-black transition-colors"
                        >
                          Cancel
                        </button>
                      )}
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className={`text-ink-muted transition-transform ${isExpanded ? "rotate-180" : ""}`}
                      >
                        <polyline points="6 9 12 15 18 9" />
                      </svg>
                    </div>
                  </div>

                  {/* Expanded stops */}
                  {isExpanded && (
                    <div className="border-t border-ink-border divide-y divide-ink-border animate-fade-in">
                      <div className="grid grid-cols-[2rem_1fr_1fr_3rem] gap-2 px-4 py-2 text-[11px] font-mono text-ink-muted uppercase tracking-wide bg-ink-surface/50">
                        <div>#</div>
                        <div>Invoice</div>
                        <div>Customer</div>
                        <div className="text-right">NOP</div>
                      </div>
                      {trip.stops.map((stop) => (
                        <div
                          key={stop.id}
                          className={`px-4 py-3 hover:bg-ink-surface/30 transition-colors ${
                            stopMatchesQuery(stop)
                              ? "bg-ink-green-dim/20 border-l-2 border-l-ink-green"
                              : ""
                          }`}
                        >
                          {/* Line 1: #, Invoice, Customer, NOP */}
                          <div className="grid grid-cols-[2rem_1fr_1fr_3rem] gap-2 items-center">
                            <span className="w-6 h-6 rounded bg-ink-surface flex items-center justify-center font-mono text-xs text-ink-muted font-medium">
                              {stop.stopNumber}
                            </span>
                            <span className="font-mono text-[13px] font-medium text-ink-black truncate">
                              {stop.invoiceNumber}
                            </span>
                            <span className="text-[13px] text-ink-muted truncate">
                              {stop.customerName}
                            </span>
                            <span className="text-[13px] font-mono text-ink-muted text-right">
                              {stop.nop > 0 ? stop.nop : "—"}
                            </span>
                          </div>
                          {/* Collections at this stop. Listed under the
                              delivery rather than beside it, because it is one
                              visit to one address — the driver sees the same
                              shape on their run sheet. */}
                          {(stop.collections?.length ?? 0) > 0 && (
                            <div className="mt-2 pl-8 space-y-1">
                              {stop.collections!.map((c) => (
                                <div
                                  key={c.id}
                                  className="flex items-center gap-2 flex-wrap text-[12px]"
                                >
                                  <span
                                    className={
                                      c.type === "CREDIT_RETURN" ? "badge-credit" : "badge-uplift"
                                    }
                                  >
                                    {c.type === "CREDIT_RETURN" ? "Credit Return" : "Uplift"}
                                  </span>
                                  <span className="font-mono text-ink-black">
                                    {c.collectionNo}
                                  </span>
                                  {c.originalInvoiceNo && (
                                    <span className="text-ink-muted">
                                      against {c.originalInvoiceNo}
                                    </span>
                                  )}
                                  {(c.collectedQty != null || c.expectedQty != null) && (
                                    <span className="font-mono text-ink-muted">
                                      {c.collectedQty ?? 0} of {c.expectedQty ?? "—"}
                                    </span>
                                  )}
                                  <span
                                    className={
                                      c.status === "COLLECTED"
                                        ? "badge-signed"
                                        : COLLECTION_EXCEPTIONS.has(c.status)
                                        ? "badge-progress"
                                        : "badge-pending"
                                    }
                                  >
                                    {COLLECTION_STATUS_LABEL[c.status] ?? c.status}
                                  </span>
                                  {c.exceptionReason && (
                                    <span className="text-ink-amber truncate max-w-[18rem]">
                                      {c.exceptionReason}
                                    </span>
                                  )}
                                  {c.signedFilePath && (
                                    <a
                                      href={`/api/collections/document/${encodeURIComponent(c.signedFilePath)}?signed=true`}
                                      target="_blank"
                                      rel="noreferrer"
                                      onClick={(e) => e.stopPropagation()}
                                      className="font-mono text-[11px] text-ink-violet hover:underline"
                                    >
                                      Receipt
                                    </a>
                                  )}
                                  {c.sourceFilePath && (
                                    <a
                                      href={`/api/collections/document/${encodeURIComponent(c.sourceFilePath)}`}
                                      target="_blank"
                                      rel="noreferrer"
                                      onClick={(e) => e.stopPropagation()}
                                      className="font-mono text-[11px] text-ink-muted hover:text-ink-black hover:underline"
                                    >
                                      Document
                                    </a>
                                  )}
                                </div>
                              ))}
                            </div>
                          )}
                          {/* Line 2: Email button + Status badge.
                              The confirmation goes out automatically on
                              signature, so this button is a resend — or the
                              recovery when the automatic attempt failed. */}
                          <div className="flex items-center gap-2 mt-1.5 pl-8">
                            {stop.status === "SIGNED" && stop.contact?.email && (() => {
                              const live = emailSending[stop.id];
                              const isSent = live === "sent" || (!live && (stop.emailStatus === "SENT" || (!stop.emailStatus && stop.emailSentAt)));
                              const isFailed = live === "failed" || (!live && stop.emailStatus === "FAILED");
                              const isSending = live === "sending" || (!live && stop.emailStatus === "SENDING");
                              return (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleResendEmail(stop, trip.driverName);
                                }}
                                disabled={live === "sending"}
                                className={`flex items-center gap-1 px-2 py-1 rounded text-[11px] font-mono font-medium transition-all ${
                                  isSent
                                    ? "bg-ink-green-dim text-ink-green border border-ink-green/20"
                                    : isFailed
                                    ? "bg-ink-red-dim text-ink-red border border-ink-red/20 hover:bg-ink-red/10"
                                    : isSending
                                    ? "bg-ink-surface text-ink-muted border border-ink-border"
                                    : "bg-ink-surface text-ink-muted border border-ink-border hover:border-ink-muted-light hover:text-ink-black"
                                }`}
                                title={
                                  isFailed
                                    ? `Last attempt failed${stop.emailError ? `: ${stop.emailError}` : ""} — click to retry ${stop.contact.email}`
                                    : isSent
                                    ? `Email sent — click to resend to ${stop.contact.email}`
                                    : `Send delivery confirmation to ${stop.contact.email}`
                                }
                              >
                                {isSending ? (
                                  <>
                                    <div className="w-3 h-3 border-2 border-ink-muted/30 border-t-ink-muted rounded-full animate-spin" />
                                    Sending…
                                  </>
                                ) : isSent ? (
                                  <>
                                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                      <polyline points="20 6 9 17 4 12" />
                                    </svg>
                                    Sent
                                  </>
                                ) : isFailed ? (
                                  <>
                                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                      <circle cx="12" cy="12" r="10" />
                                      <line x1="15" y1="9" x2="9" y2="15" />
                                      <line x1="9" y1="9" x2="15" y2="15" />
                                    </svg>
                                    Retry
                                  </>
                                ) : (
                                  <>
                                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                      <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
                                      <polyline points="22,6 12,13 2,6" />
                                    </svg>
                                    Email
                                  </>
                                )}
                              </button>
                              );
                            })()}
                            {stop.status === "SIGNED" && !stop.contact?.email && (
                              <span
                                className="inline-flex items-center px-2 py-1 rounded text-[11px] font-mono bg-ink-amber-dim text-ink-amber border border-ink-amber/20"
                                title="No email address on this contact — add one to send a confirmation"
                              >
                                No email
                              </span>
                            )}
                            {(stop.collections?.length ?? 0) > 0 && (
                              <span
                                className="badge-credit"
                                title="This stop also has goods coming back"
                              >
                                {stop.collections!.length} collection
                                {stop.collections!.length !== 1 ? "s" : ""}
                              </span>
                            )}
                            <span
                              className={
                                stop.status === "SIGNED"
                                  ? "badge-signed"
                                  : stop.status === "IN_PROGRESS"
                                  ? "badge-progress"
                                  : "badge-pending"
                              }
                            >
                              <span
                                className={`w-1.5 h-1.5 rounded-full ${
                                  stop.status === "SIGNED"
                                    ? "bg-ink-green"
                                    : stop.status === "IN_PROGRESS"
                                    ? "bg-ink-amber"
                                    : "bg-ink-red"
                                }`}
                              />
                              {stop.status === "SIGNED"
                                ? "Signed"
                                : stop.status === "IN_PROGRESS"
                                ? "Active"
                                : "Pending"}
                            </span>
                          </div>
                        </div>
                      ))}
                      <div className="px-4 py-2 text-[11px] text-ink-muted bg-ink-surface/30">
                        Uploaded {formatDate(trip.uploadedAt)}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}

            {visibleTripSheets.length === 0 && (
              <div className="py-8 text-center">
                <p className="text-sm font-mono text-ink-muted">
                  No active sheet matches “{tripQuery.trim()}”
                </p>
                <p className="text-xs text-ink-muted mt-1">
                  Driver, vehicle, source file, invoice number and customer are all searched
                </p>
                <button
                  onClick={() => handleTripQueryChange("")}
                  className="mt-3 px-3 py-1.5 text-xs font-mono text-ink-muted bg-ink-surface border border-ink-border rounded hover:text-ink-black hover:border-ink-black/30 transition-all"
                >
                  Clear search
                </button>
              </div>
            )}

            {/* Trip sheets pagination */}
            {totalTripPages > 1 && (
              <div className="flex items-center justify-between px-4 py-3 bg-ink-card border border-ink-border rounded">
                <p className="text-xs font-mono text-ink-muted">
                  Showing {(tripPage - 1) * ITEMS_PER_PAGE + 1}–{Math.min(tripPage * ITEMS_PER_PAGE, visibleTripSheets.length)} of {visibleTripSheets.length} trip sheets
                </p>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => setTripPage(1)}
                    disabled={tripPage === 1}
                    className="px-2 py-1 text-xs font-mono text-ink-muted hover:text-ink-black disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                  >
                    «
                  </button>
                  <button
                    onClick={() => setTripPage((p) => Math.max(1, p - 1))}
                    disabled={tripPage === 1}
                    className="px-2 py-1 text-xs font-mono text-ink-muted hover:text-ink-black disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                  >
                    ‹ Prev
                  </button>
                  {Array.from({ length: totalTripPages }, (_, i) => i + 1)
                    .filter((p) => p === 1 || p === totalTripPages || Math.abs(p - tripPage) <= 2)
                    .map((p, idx, arr) => (
                      <span key={p} className="flex items-center">
                        {idx > 0 && arr[idx - 1] !== p - 1 && (
                          <span className="px-1 text-xs text-ink-muted-light">…</span>
                        )}
                        <button
                          onClick={() => setTripPage(p)}
                          className={`w-7 h-7 text-xs font-mono rounded transition-colors ${
                            p === tripPage
                              ? "bg-ink-black text-white"
                              : "text-ink-muted hover:text-ink-black hover:bg-ink-surface"
                          }`}
                        >
                          {p}
                        </button>
                      </span>
                    ))}
                  <button
                    onClick={() => setTripPage((p) => Math.min(totalTripPages, p + 1))}
                    disabled={tripPage === totalTripPages}
                    className="px-2 py-1 text-xs font-mono text-ink-muted hover:text-ink-black disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                  >
                    Next ›
                  </button>
                  <button
                    onClick={() => setTripPage(totalTripPages)}
                    disabled={tripPage === totalTripPages}
                    className="px-2 py-1 text-xs font-mono text-ink-muted hover:text-ink-black disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                  >
                    »
                  </button>
                </div>
              </div>
            )}
                </>
              );
            })()}
          </div>
          )}

          {/* ─── Completed Trip Sheets ──────────────────────────────────── */}
          {showActiveTrips && tripTab === "completed" && (
            <div className="animate-fade-in">
              {/* Range toggle + summary */}
              <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-ink-border bg-ink-surface/30 flex-wrap">
                <p className="text-xs font-mono text-ink-muted">
                  {visibleCompletedSheets.length} sheet
                  {visibleCompletedSheets.length !== 1 ? "s" : ""}{" "}
                  {tripTokens.length > 0 ? "matching" : "closed out"}
                  {tripTokens.length === 0 && completedRange === "today" ? " today" : ""}
                  {visibleCompletedSheets.length > 0 && (
                    <>
                      {" · "}
                      <span className="text-ink-green">
                        {visibleCompletedSheets.reduce((sum, c) => sum + c.signedStops, 0)} deliveries
                      </span>
                    </>
                  )}
                </p>
                <div className="flex items-center gap-1 shrink-0">
                  {(["today", "all"] as const).map((r) => (
                    <button
                      key={r}
                      onClick={() => setCompletedRange(r)}
                      className={`px-3 py-1 text-[11px] font-mono rounded transition-colors ${
                        completedRange === r
                          ? "bg-ink-black text-white"
                          : "text-ink-muted hover:text-ink-black hover:bg-ink-surface"
                      }`}
                    >
                      {r === "today" ? "Today" : "All"}
                    </button>
                  ))}
                  <button
                    onClick={fetchCompletedSheets}
                    disabled={completedLoading}
                    className="flex items-center gap-1.5 ml-1 px-2.5 py-1 text-[11px] font-mono text-ink-muted hover:text-ink-black border border-ink-border rounded hover:border-ink-muted-light transition-all"
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={completedLoading ? "animate-spin" : ""}>
                      <polyline points="23 4 23 10 17 10" />
                      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                    </svg>
                    Refresh
                  </button>
                </div>
              </div>

              {visibleCompletedSheets.length === 0 ? (
                <div className="p-8 text-center">
                  {tripTokens.length > 0 ? (
                    <>
                      <p className="text-sm text-ink-muted font-mono">
                        No completed sheet matches “{tripQuery.trim()}”
                      </p>
                      <p className="text-xs text-ink-muted mt-1">
                        {completedRange === "today"
                          ? "Only today's sheets are loaded — switch to All to search the whole archive"
                          : "Driver, vehicle, source file, invoice number and customer are all searched"}
                      </p>
                    </>
                  ) : (
                    <>
                      <p className="text-sm text-ink-muted font-mono">
                        {completedRange === "today"
                          ? "Nothing closed out today yet"
                          : "No completed trip sheets"}
                      </p>
                      <p className="text-xs text-ink-muted mt-1">
                        A sheet lands here once every stop is signed and you press Complete
                      </p>
                    </>
                  )}
                </div>
              ) : (
                <div className="p-4 space-y-6">
                  {completedByDay.map((group) => (
                    <div key={group.key}>
                      {/* Day heading — the run sheet for that date, in one block */}
                      <div className="flex items-baseline justify-between gap-3 mb-2.5 pb-1.5 border-b border-ink-border">
                        <h3 className="font-mono text-[12px] font-medium text-ink-black uppercase tracking-wide">
                          {group.label}
                        </h3>
                        <p className="text-[11px] font-mono text-ink-muted">
                          {group.sheets.length} sheet{group.sheets.length !== 1 ? "s" : ""}
                          {" · "}
                          <span className="text-ink-green">{group.deliveries} deliveries</span>
                        </p>
                      </div>
                      <div className="space-y-3 stagger-children">
                  {group.sheets.map((sheet) => {
                    const isExpanded = expandedCompleted === sheet.id;
                    const stopHits =
                      tripTokens.length > 0 ? sheet.stops.filter(stopMatchesQuery).length : 0;
                    return (
                      <div
                        key={sheet.id}
                        className="bg-ink-card border border-ink-border rounded overflow-hidden"
                      >
                        <button
                          onClick={() => setExpandedCompleted(isExpanded ? null : sheet.id)}
                          className="flex items-center gap-3 w-full px-5 py-4 text-left hover:bg-ink-surface/50 transition-colors"
                        >
                          <div className="w-9 h-9 rounded bg-ink-green-dim flex items-center justify-center shrink-0">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#00C07F" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                              <polyline points="20 6 9 17 4 12" />
                            </svg>
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <p className="text-[15px] sm:text-sm font-medium text-ink-black">
                                {sheet.driverName}
                              </p>
                              {sheet.regNo && (
                                <span className="text-[12px] sm:text-xs font-mono text-ink-muted">
                                  {sheet.regNo}
                                </span>
                              )}
                              <span className="badge-signed">
                                <span className="w-1.5 h-1.5 rounded-full bg-ink-green" />
                                {sheet.signedStops}/{sheet.totalStops} delivered
                              </span>
                              {(sheet.collections?.length ?? 0) > 0 && (
                                <span className="badge-credit">
                                  {sheet.collectedCollections ?? 0}/{sheet.collections!.length} collected
                                </span>
                              )}
                              {(sheet.collections ?? []).some((c) =>
                                COLLECTION_EXCEPTIONS.has(c.status)
                              ) && (
                                <span
                                  className="inline-flex items-center px-1.5 py-0.5 text-[10px] font-mono rounded bg-ink-amber-dim text-ink-amber border border-ink-amber/20"
                                  title="A collection was partial, unavailable or refused — accounts needs to look at it before raising a credit"
                                >
                                  COLLECTION EXCEPTION
                                </span>
                              )}
                              {stopHits > 0 && (
                                <span className="inline-flex items-center px-1.5 py-0.5 text-[10px] font-mono font-medium rounded bg-ink-green-dim text-ink-green border border-ink-green/20">
                                  {stopHits} stop{stopHits !== 1 ? "s" : ""} match
                                </span>
                              )}
                              {!sheet.archivedFile && (
                                <span
                                  className="inline-flex items-center px-1.5 py-0.5 text-[10px] font-mono rounded bg-ink-amber-dim text-ink-amber border border-ink-amber/20"
                                  title="The source file was not moved to processed/, so it will not appear in backups"
                                >
                                  NOT ARCHIVED
                                </span>
                              )}
                            </div>
                            <p className="text-[12px] sm:text-xs text-ink-muted font-mono mt-1 truncate">
                              {sheet.sourceFilename} · closed {formatDate(sheet.completedAt)}
                              {sheet.completedBy ? ` by ${sheet.completedBy}` : ""}
                            </p>
                          </div>
                          <svg
                            width="14"
                            height="14"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            className={`text-ink-muted transition-transform shrink-0 ${isExpanded ? "rotate-180" : ""}`}
                          >
                            <polyline points="6 9 12 15 18 9" />
                          </svg>
                        </button>

                        {isExpanded && (
                          <div className="border-t border-ink-border divide-y divide-ink-border animate-fade-in">
                            <div className="grid grid-cols-[2rem_1fr_1fr_auto] gap-2 px-4 py-2 text-[11px] font-mono text-ink-muted uppercase tracking-wide bg-ink-surface/50">
                              <div>#</div>
                              <div>Invoice</div>
                              <div>Customer</div>
                              <div className="text-right">Signed</div>
                            </div>
                            {sheet.stops.map((stop) => (
                              <div
                                key={`${sheet.id}-${stop.stopNumber}-${stop.invoiceNumber}`}
                                className={`px-4 py-2.5 hover:bg-ink-surface/30 transition-colors ${
                                  stopMatchesQuery(stop)
                                    ? "bg-ink-green-dim/20 border-l-2 border-l-ink-green"
                                    : ""
                                }`}
                              >
                                <div className="grid grid-cols-[2rem_1fr_1fr_auto] gap-2 items-center">
                                  <span className="w-6 h-6 rounded bg-ink-surface flex items-center justify-center font-mono text-xs text-ink-muted font-medium">
                                    {stop.stopNumber}
                                  </span>
                                  <span className="font-mono text-[13px] font-medium text-ink-black truncate">
                                    {stop.invoiceNumber}
                                  </span>
                                  <span className="text-[13px] text-ink-muted truncate">
                                    {stop.customerName}
                                  </span>
                                  <div className="flex items-center gap-2 justify-end">
                                    <CompletedEmailPill status={stop.emailStatus} />
                                    <span className="text-[12px] font-mono text-ink-muted">
                                      {stop.signedAt
                                        ? new Date(stop.signedAt).toLocaleTimeString("en-ZA", {
                                            hour: "2-digit",
                                            minute: "2-digit",
                                          })
                                        : "—"}
                                    </span>
                                  </div>
                                </div>
                              </div>
                            ))}
                            {/* Collections stay reachable as backup after the
                                trip is closed. The Collection rows cascade away
                                with the trip sheet, so this reads the frozen
                                snapshot — including the ones with no signed PDF,
                                which are exactly the ones a credit clerk has to
                                chase. */}
                            {(sheet.collections?.length ?? 0) > 0 && (
                              <>
                                <div className="grid grid-cols-[2rem_1fr_1fr_auto] gap-2 px-4 py-2 text-[11px] font-mono text-ink-muted uppercase tracking-wide bg-ink-violet-dim">
                                  <div>#</div>
                                  <div>Collection</div>
                                  <div>Customer</div>
                                  <div className="text-right">Outcome</div>
                                </div>
                                {sheet.collections!.map((c, i) => (
                                  <div
                                    key={`${sheet.id}-col-${c.collectionNo}-${i}`}
                                    className="px-4 py-2.5 hover:bg-ink-surface/30 transition-colors"
                                  >
                                    <div className="grid grid-cols-[2rem_1fr_1fr_auto] gap-2 items-center">
                                      <span className="w-6 h-6 rounded bg-ink-surface flex items-center justify-center font-mono text-xs text-ink-muted font-medium">
                                        {c.stopNumber ?? "—"}
                                      </span>
                                      <div className="min-w-0">
                                        <span className="font-mono text-[13px] font-medium text-ink-black truncate block">
                                          {c.collectionNo}
                                        </span>
                                        <span className="text-[11px] text-ink-muted">
                                          {c.type === "CREDIT_RETURN" ? "Credit Return" : "Uplift"}
                                          {c.originalInvoiceNo ? ` · against ${c.originalInvoiceNo}` : ""}
                                          {c.collectedQty != null || c.expectedQty != null
                                            ? ` · ${c.collectedQty ?? 0} of ${c.expectedQty ?? "—"}`
                                            : ""}
                                        </span>
                                      </div>
                                      <div className="min-w-0">
                                        <span className="text-[13px] text-ink-muted truncate block">
                                          {c.customerName}
                                        </span>
                                        {c.exceptionReason && (
                                          <span className="text-[11px] text-ink-amber truncate block">
                                            {c.exceptionReason}
                                          </span>
                                        )}
                                      </div>
                                      <div className="flex items-center gap-2 justify-end">
                                        <span
                                          className={
                                            c.status === "COLLECTED"
                                              ? "badge-signed"
                                              : COLLECTION_EXCEPTIONS.has(c.status)
                                              ? "badge-progress"
                                              : "badge-pending"
                                          }
                                        >
                                          {COLLECTION_STATUS_LABEL[c.status] ?? c.status}
                                        </span>
                                        {c.signedFilePath ? (
                                          <a
                                            href={`/api/collections/document/${encodeURIComponent(c.signedFilePath)}?signed=true`}
                                            target="_blank"
                                            rel="noreferrer"
                                            className="text-[11px] font-mono text-ink-violet hover:underline"
                                          >
                                            Receipt
                                          </a>
                                        ) : (
                                          <span
                                            className="text-[11px] font-mono text-ink-muted-light"
                                            title="No signed document was written for this collection"
                                          >
                                            No receipt
                                          </span>
                                        )}
                                        {c.sourceFilePath && (
                                          <a
                                            href={`/api/collections/document/${encodeURIComponent(c.sourceFilePath)}`}
                                            target="_blank"
                                            rel="noreferrer"
                                            className="text-[11px] font-mono text-ink-muted hover:text-ink-black hover:underline"
                                          >
                                            Original
                                          </a>
                                        )}
                                      </div>
                                    </div>
                                  </div>
                                ))}
                              </>
                            )}
                            <div className="px-4 py-2 text-[11px] text-ink-muted bg-ink-surface/30">
                              Uploaded {formatDate(sheet.uploadedAt)}
                              {sheet.archivedFile
                                ? ` · archived as ${sheet.archivedFile}`
                                : " · source file was not archived to processed/"}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Trip sheets delete confirmation modal */}
      {showTripDeleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 animate-fade-in" onClick={() => setShowTripDeleteConfirm(false)}>
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full mx-4 overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <div className="px-6 py-5">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 rounded-full bg-ink-red-dim flex items-center justify-center">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-ink-red">
                    <polyline points="3 6 5 6 21 6" />
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                  </svg>
                </div>
                <div>
                  <h3 className="font-mono text-sm font-medium text-ink-black">Delete {selectedTrips.size} trip sheet{selectedTrips.size !== 1 ? "s" : ""}?</h3>
                  <p className="text-xs text-ink-muted mt-0.5">This will remove the trip sheet records and all associated stops</p>
                </div>
              </div>
              <div className="max-h-32 overflow-y-auto bg-ink-surface rounded p-2 mb-4">
                {tripSheets.filter((t) => selectedTrips.has(t.id)).map((t) => (
                  <p key={t.id} className="text-xs font-mono text-ink-black py-0.5 truncate">
                    {t.driverName} — {t.sourceFilename} ({t.stops.length} stops)
                  </p>
                ))}
              </div>
            </div>
            <div className="flex justify-end gap-3 px-6 py-4 bg-ink-surface/50 border-t border-ink-border">
              <button
                onClick={() => setShowTripDeleteConfirm(false)}
                className="px-4 py-2 text-sm font-mono text-ink-muted hover:text-ink-black transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleBatchDeleteTrips}
                disabled={deletingTrips}
                className="flex items-center gap-2 px-4 py-2 text-sm font-mono font-medium text-white bg-ink-red rounded hover:bg-red-600 transition-all disabled:opacity-50"
              >
                {deletingTrips ? (
                  <>
                    <div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    Deleting…
                  </>
                ) : (
                  "Delete Trip Sheets"
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Complete confirmation modal */}
      {showCompleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 animate-fade-in" onClick={() => setShowCompleteConfirm(false)}>
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full mx-4 overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <div className="px-6 py-5">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 rounded-full bg-ink-green-dim flex items-center justify-center">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-ink-green">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                </div>
                <div>
                  <h3 className="font-mono text-sm font-medium text-ink-black">Complete {selectedCompletableTrips.length} trip sheet{selectedCompletableTrips.length !== 1 ? "s" : ""}?</h3>
                  <p className="text-xs text-ink-muted mt-0.5">Source files will be moved to the processed folder</p>
                </div>
              </div>
              {selectedTrips.size !== selectedCompletableTrips.length && (
                <div className="flex items-center gap-2 px-3 py-2 bg-ink-amber-dim rounded border border-ink-amber/20 mb-3">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-ink-amber shrink-0">
                    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                    <line x1="12" y1="9" x2="12" y2="13" />
                    <line x1="12" y1="17" x2="12.01" y2="17" />
                  </svg>
                  <p className="text-[11px] font-mono text-ink-amber">
                    {selectedTrips.size - selectedCompletableTrips.length} selected trip(s) have unsigned stops and will be skipped
                  </p>
                </div>
              )}
              <div className="max-h-32 overflow-y-auto bg-ink-surface rounded p-2 mb-4">
                {selectedCompletableTrips.map((t) => (
                  <div key={t.id} className="flex items-center gap-2 py-1">
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#00C07F" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                    <p className="text-xs font-mono text-ink-black truncate">
                      {t.driverName} — {t.sourceFilename} ({t.stops.length} stops)
                    </p>
                  </div>
                ))}
              </div>
            </div>
            <div className="flex justify-end gap-3 px-6 py-4 bg-ink-surface/50 border-t border-ink-border">
              <button
                onClick={() => setShowCompleteConfirm(false)}
                className="px-4 py-2 text-sm font-mono text-ink-muted hover:text-ink-black transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleBatchCompleteTrips}
                disabled={completingTrips}
                className="flex items-center gap-2 px-4 py-2 text-sm font-mono font-medium text-white bg-ink-green rounded hover:bg-ink-green-hover transition-all disabled:opacity-50"
              >
                {completingTrips ? (
                  <>
                    <div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    Archiving…
                  </>
                ) : (
                  "Complete & Archive"
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Success notification */}
      {completeSuccess && (
        <div className="fixed bottom-6 right-6 z-50 flex items-center gap-3 px-5 py-3 bg-ink-green text-white rounded-lg shadow-lg animate-fade-in">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
          <span className="text-sm font-mono font-medium">{completeSuccess}</span>
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="mt-8 bg-ink-card border border-ink-border rounded p-12 text-center">
          <div className="w-6 h-6 border-2 border-ink-border border-t-ink-green rounded-full animate-spin mx-auto mb-3" />
          <p className="text-sm font-mono text-ink-muted">Loading trip data…</p>
        </div>
      )}
    </div>
  );
}

/**
 * Where a completed stop's confirmation email got to. Frozen at completion
 * time, so it is a record of what happened rather than something to act on —
 * the send queue on the dashboard is where outstanding mail is dealt with.
 */
function CompletedEmailPill({ status }: { status: string }) {
  if (status === "SENT") {
    return (
      <span
        className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-mono rounded bg-ink-green-dim text-ink-green shrink-0"
        title="Confirmation email sent"
      >
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
        Emailed
      </span>
    );
  }

  const map: Record<string, { label: string; className: string; title: string }> = {
    FAILED: {
      label: "Email failed",
      className: "bg-ink-red-dim text-ink-red",
      title: "The confirmation email did not go out",
    },
    NO_EMAIL: {
      label: "No address",
      className: "bg-ink-amber-dim text-ink-amber",
      title: "This customer had no email address on file",
    },
  };

  const pill = map[status];
  if (!pill) return null;

  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 text-[10px] font-mono rounded shrink-0 ${pill.className}`}
      title={pill.title}
    >
      {pill.label}
    </span>
  );
}
