"use client";

import { useState, useEffect, useRef, useCallback } from "react";

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
  contact?: { email?: string };
}

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
}

interface AlreadySignedInvoice {
  invoiceNumber: string;
  signedAt: string | null;
  driverName: string | null;
  source: "database" | "filesystem";
}

interface PreviewData {
  success: boolean;
  filename?: string;
  preview: {
    totalRows: number;
    matchedInvoices: number;
    unmatchedInvoices: number;
    driverResults: MatchResult[];
    alreadySigned: AlreadySignedInvoice[];
  };
}

interface Stats {
  totalStops: number;
  signed: number;
  pending: number;
  inProgress: number;
  activeDrivers: number;
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

  useEffect(() => {
    fetchTripSheets();
    fetchCloudFolder();
    // Also fetch drivers for assignment dropdown
    fetch("/api/drivers")
      .then((r) => r.json())
      .then((data) => setDrivers((data.drivers || []).filter((d: DriverAccount) => d.active)))
      .catch(() => {});

    // Auto-poll cloud folder every 30 seconds
    const pollInterval = setInterval(() => {
      fetchCloudFolder();
    }, 30000);

    return () => clearInterval(pollInterval);
  }, [fetchTripSheets, fetchCloudFolder]);

  // ─── File Upload ──────────────────────────────────────────────────────

  const handleFile = async (file: File) => {
    setError(null);
    setPreview(null);
    setUploadedFile(file);
    setUploading(true);

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

        if (!res.ok) {
          setError(data.error || "Deploy failed");
        } else {
          setPreview(null);
          setImportSourceFile(null);
          setAssignToDriverId("");
          setSkippedInvoices(new Set());
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

        if (!res.ok) {
          setError(data.error || "Deploy failed");
        } else {
          setPreview(null);
          setUploadedFile(null);
          setAssignToDriverId("");
          setSkippedInvoices(new Set());
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
    const allFilenames = cloudFolder.files.map((f) => f.filename);
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
    if (selectedTrips.size === tripSheets.length) {
      setSelectedTrips(new Set());
    } else {
      setSelectedTrips(new Set(tripSheets.map((t) => t.id)));
    }
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
        <button
          onClick={() => setShowUpload(!showUpload)}
          className={`flex items-center gap-2 px-4 py-2.5 font-mono text-sm font-medium rounded transition-all shrink-0 ${
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
            {/* Select all row */}
            <div className="flex items-center gap-3 px-5 py-2 border-b border-ink-border bg-ink-surface/30">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={cloudFolder.files.length > 0 && selectedCloudFiles.size === cloudFolder.files.length}
                  onChange={toggleAllCloudFiles}
                  className="w-3.5 h-3.5 rounded border-ink-border text-ink-green accent-[#00C07F] cursor-pointer"
                />
                <span className="text-[11px] font-mono text-ink-muted">
                  {selectedCloudFiles.size > 0 ? `${selectedCloudFiles.size} selected` : "Select all"}
                </span>
              </label>
            </div>
            <div className="divide-y divide-ink-border">
              {cloudFolder.files
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
            {cloudFolder.files.length > ITEMS_PER_PAGE && (() => {
              const totalCloudPages = Math.ceil(cloudFolder.files.length / ITEMS_PER_PAGE);
              return (
                <div className="flex items-center justify-between px-5 py-2.5 border-t border-ink-border bg-ink-surface/30">
                  <p className="text-xs font-mono text-ink-muted">
                    {(cloudPage - 1) * ITEMS_PER_PAGE + 1}–{Math.min(cloudPage * ITEMS_PER_PAGE, cloudFolder.files.length)} of {cloudFolder.files.length}
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
              </div>
            </div>

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
                          {result.regNo || "No REG No"} · {result.stops.filter((s) => !skippedInvoices.has(s.invoiceNumber)).length} stop{result.stops.filter((s) => !skippedInvoices.has(s.invoiceNumber)).length !== 1 ? "s" : ""}
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
                  All invoices on this trip sheet have already been signed
                </p>
                <p className="text-xs text-ink-muted mt-1">
                  There are no remaining stops to deploy. Please upload a new trip sheet.
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
                setError(null);
              }}
              className="px-5 py-2.5 text-sm font-mono text-ink-muted hover:text-ink-black transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleDeploy}
              disabled={deploying || allStopsSkipped || ((!assignedResults || assignedResults.length === 0) && !assignToDriverId)}
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

      {/* ─── Active Trip Sheets ─────────────────────────────────────────── */}
      {!preview && !loading && tripSheets.length > 0 && (
        <div className="mt-8 bg-ink-card border border-ink-border rounded overflow-hidden">
          <button
            onClick={() => setShowActiveTrips(!showActiveTrips)}
            className="flex items-center justify-between w-full px-5 py-4 hover:bg-ink-surface/50 transition-colors"
          >
            <div className="flex items-center gap-2">
              <h2 className="font-mono text-[13px] sm:text-sm font-medium text-ink-black uppercase tracking-wide">
                Active Trip Sheets
              </h2>
              <span className="inline-flex items-center px-2 py-0.5 text-[10px] font-mono font-medium rounded-full bg-ink-surface text-ink-muted">
                {tripSheets.length}
              </span>
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
              className={`text-ink-muted transition-transform ${showActiveTrips ? "rotate-180" : ""}`}
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
          {showActiveTrips && (
          <div className="space-y-3 p-4 pt-0 stagger-children border-t border-ink-border">
            {/* Select all */}
            <div className="flex items-center gap-3 py-2">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={tripSheets.length > 0 && selectedTrips.size === tripSheets.length}
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
              const totalTripPages = Math.ceil(tripSheets.length / ITEMS_PER_PAGE);
              const paginatedTrips = tripSheets.slice(
                (tripPage - 1) * ITEMS_PER_PAGE,
                tripPage * ITEMS_PER_PAGE
              );
              return (
                <>
            {paginatedTrips.map((trip) => {
              const signed = trip.stops.filter((s) => s.status === "SIGNED").length;
              const total = trip.stops.length;
              const pct = total > 0 ? Math.round((signed / total) * 100) : 0;
              const isExpanded = expandedTrip === trip.id;

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
                          className="px-4 py-3 hover:bg-ink-surface/30 transition-colors"
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
                          {/* Line 2: Email button + Status badge */}
                          <div className="flex items-center gap-2 mt-1.5 pl-8">
                            {stop.status === "SIGNED" && stop.contact?.email && (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleResendEmail(stop, trip.driverName);
                                }}
                                disabled={emailSending[stop.id] === "sending"}
                                className={`flex items-center gap-1 px-2 py-1 rounded text-[11px] font-mono font-medium transition-all ${
                                  emailSending[stop.id] === "sent" || (!emailSending[stop.id] && stop.emailSentAt)
                                    ? "bg-ink-green-dim text-ink-green border border-ink-green/20"
                                    : emailSending[stop.id] === "failed"
                                    ? "bg-ink-red-dim text-ink-red border border-ink-red/20 hover:bg-ink-red/10"
                                    : emailSending[stop.id] === "sending"
                                    ? "bg-ink-surface text-ink-muted border border-ink-border"
                                    : "bg-ink-surface text-ink-muted border border-ink-border hover:border-ink-muted-light hover:text-ink-black"
                                }`}
                                title={stop.emailSentAt && !emailSending[stop.id]
                                  ? `Email sent — click to resend to ${stop.contact.email}`
                                  : `Send delivery confirmation to ${stop.contact.email}`}
                              >
                                {emailSending[stop.id] === "sending" ? (
                                  <>
                                    <div className="w-3 h-3 border-2 border-ink-muted/30 border-t-ink-muted rounded-full animate-spin" />
                                    Sending…
                                  </>
                                ) : emailSending[stop.id] === "sent" || (!emailSending[stop.id] && stop.emailSentAt) ? (
                                  <>
                                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                      <polyline points="20 6 9 17 4 12" />
                                    </svg>
                                    Sent
                                  </>
                                ) : emailSending[stop.id] === "failed" ? (
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

            {/* Trip sheets pagination */}
            {totalTripPages > 1 && (
              <div className="flex items-center justify-between px-4 py-3 bg-ink-card border border-ink-border rounded">
                <p className="text-xs font-mono text-ink-muted">
                  Showing {(tripPage - 1) * ITEMS_PER_PAGE + 1}–{Math.min(tripPage * ITEMS_PER_PAGE, tripSheets.length)} of {tripSheets.length} trip sheets
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

      {/* ─── Empty State ────────────────────────────────────────────────── */}
      {!preview && !loading && tripSheets.length === 0 && (
        <div className="mt-8 bg-ink-card border border-ink-border rounded p-8 text-center">
          <p className="text-sm text-ink-muted font-mono">
            No trip sheets uploaded yet
          </p>
          <p className="text-xs text-ink-muted mt-1">
            Upload a file above to preview and deploy stops to drivers
          </p>
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
