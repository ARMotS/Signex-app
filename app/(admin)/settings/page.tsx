"use client";

import { useState, useEffect, useCallback, useRef } from "react";

interface OneDriveAccount {
  connected: boolean;
  accountEmail?: string;
  accountName?: string;
  folderPath?: string;
  folderItemId?: string;
}

interface OneDriveFolder {
  id: string;
  name: string;
  folder?: { childCount: number };
  parentReference?: { path: string };
}

interface FolderEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  pdfCount?: number;
}

interface BrowseResult {
  current: string;
  parent: string | null;
  entries: FolderEntry[];
  breadcrumbs: { name: string; path: string }[];
  currentPdfCount?: number;
  fileLabel?: string;
}

interface FolderValidation {
  valid: boolean;
  exists: boolean;
  readable: boolean;
  writable: boolean;
  fileCount: number;
  pdfCount: number;
  error?: string;
}

interface SignaturePosition {
  xPercent: number;
  yPercent: number;
  widthPercent: number;
  page: "first" | "last";
}

const DEFAULT_SIG_POSITION: SignaturePosition = {
  xPercent: 65,
  yPercent: 7,
  widthPercent: 30,
  page: "last",
};

interface Settings {
  invoiceFolderPath: string;
  invoiceFolderType: string;
  tripSheetFolderPath: string;
  tripSheetFolderType: string;
  signaturePosition: SignaturePosition;
}

interface CloudSyncRoot {
  provider: string;
  label: string;
  icon: string;
  path: string;
  exists: boolean;
}

export default function SettingsPage() {
  const [settings, setSettings] = useState<Settings>({
    invoiceFolderPath: "",
    invoiceFolderType: "local",
    tripSheetFolderPath: "",
    tripSheetFolderType: "local",
    signaturePosition: DEFAULT_SIG_POSITION,
  });
  const [selectedPath, setSelectedPath] = useState("");
  const [browseData, setBrowseData] = useState<BrowseResult | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const [browserOpen, setBrowserOpen] = useState(false);
  const [browserTarget, setBrowserTarget] = useState<"invoices" | "tripsheets">("invoices");
  const [validation, setValidation] = useState<FolderValidation | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [manualPath, setManualPath] = useState("");
  const [showManualInput, setShowManualInput] = useState(false);

  // Trip sheet folder state
  const [tsSelectedPath, setTsSelectedPath] = useState("");
  const [tsValidation, setTsValidation] = useState<FolderValidation | null>(null);
  const [tsSaving, setTsSaving] = useState(false);
  const [tsSaveResult, setTsSaveResult] = useState<{ success: boolean; message: string } | null>(null);
  const [tsManualPath, setTsManualPath] = useState("");
  const [tsShowManualInput, setTsShowManualInput] = useState(false);

  // Cloud sync roots
  const [cloudRoots, setCloudRoots] = useState<CloudSyncRoot[]>([]);

  // OneDrive cloud connection state
  const [onedrive, setOnedrive] = useState<OneDriveAccount | null>(null);
  const [onedriveLoading, setOnedriveLoading] = useState(true);
  const [onedriveConnecting, setOnedriveConnecting] = useState(false);
  const [onedriveDisconnecting, setOnedriveDisconnecting] = useState(false);
  const [onedriveFolders, setOnedriveFolders] = useState<OneDriveFolder[]>([]);
  const [onedriveBrowsing, setOnedriveBrowsing] = useState(false);
  const [onedriveBrowserOpen, setOnedriveBrowserOpen] = useState(false);
  const [onedriveBreadcrumbs, setOnedriveBreadcrumbs] = useState<{ id: string; name: string }[]>([]);
  const [onedriveFolderSaving, setOnedriveFolderSaving] = useState(false);
  const [onedriveMessage, setOnedriveMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  // Signature placement state
  const [sigPosition, setSigPosition] = useState<SignaturePosition>(DEFAULT_SIG_POSITION);
  const [sigSaving, setSigSaving] = useState(false);
  const [sigSaveResult, setSigSaveResult] = useState<{ success: boolean; message: string } | null>(null);
  const [pdfPreviewUrl, setPdfPreviewUrl] = useState<string | null>(null);
  const [pdfPageCount, setPdfPageCount] = useState(1);
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
  const [pdfLoading, setPdfLoading] = useState(false);
  const [pdfError, setPdfError] = useState(false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pdfDocRef = useRef<any>(null);

  // Load current settings
  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((data) => {
        setSettings(data);
        setSelectedPath(data.invoiceFolderPath || "");
        setTsSelectedPath(data.tripSheetFolderPath || "");
        if (data.signaturePosition) {
          setSigPosition(data.signaturePosition);
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));

    // Discover cloud sync roots
    fetch("/api/settings/cloud-roots")
      .then((r) => r.json())
      .then((data) => setCloudRoots(data.roots || []))
      .catch(() => {});

    // Load OneDrive connection status
    fetch("/api/cloud/onedrive")
      .then((r) => r.json())
      .then((data) => {
        if (data.connected && data.account) {
          setOnedrive({
            connected: true,
            accountEmail: data.account.accountEmail,
            accountName: data.account.accountName,
            folderPath: data.account.folderPath,
            folderItemId: data.account.folderItemId,
          });
        } else {
          setOnedrive(null);
        }
      })
      .catch(() => setOnedrive(null))
      .finally(() => setOnedriveLoading(false));
  }, []);

  // Check URL params for OAuth callback result
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("cloud_connected") === "true") {
      setOnedriveMessage({ type: "success", text: "OneDrive connected successfully!" });
      // Refresh connection status
      fetch("/api/cloud/onedrive")
        .then((r) => r.json())
        .then((data) => {
          if (data.connected && data.account) {
            setOnedrive({
              connected: true,
              accountEmail: data.account.accountEmail,
              accountName: data.account.accountName,
              folderPath: data.account.folderPath,
              folderItemId: data.account.folderItemId,
            });
          }
        })
        .catch(() => {});
      window.history.replaceState({}, "", "/settings");
      setTimeout(() => setOnedriveMessage(null), 5000);
    } else if (params.get("cloud_error")) {
      setOnedriveMessage({ type: "error", text: params.get("cloud_error")! });
      window.history.replaceState({}, "", "/settings");
      setTimeout(() => setOnedriveMessage(null), 8000);
    }
  }, []);

  // Load first available invoice PDF for preview
  useEffect(() => {
    fetch("/api/invoices")
      .then((r) => r.json())
      .then((data) => {
        const invoices = data.invoices || [];
        if (invoices.length > 0) {
          setPdfPreviewUrl(`/api/invoices/${encodeURIComponent(invoices[0].filename)}`);
        }
      })
      .catch(() => {});
  }, []);

  // Load PDF.js library and PDF document (no canvas dependency)
  useEffect(() => {
    if (!pdfPreviewUrl) return;
    setPdfLoading(true);

    const loadPdf = async () => {
      // Dynamically load pdf.js from CDN (v3.11.174 — stable, non-module)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (!(window as any).pdfjsLib) {
        await new Promise<void>((resolve) => {
          const script = document.createElement("script");
          script.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
          script.onload = () => resolve();
          script.onerror = () => resolve();
          document.head.appendChild(script);
        });
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pdfjsLib = (window as any).pdfjsLib;
      if (!pdfjsLib) {
        setPdfLoading(false);
        return;
      }

      pdfjsLib.GlobalWorkerOptions.workerSrc =
        "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

      try {
        const pdf = await pdfjsLib.getDocument(pdfPreviewUrl).promise;
        pdfDocRef.current = pdf;
        setPdfPageCount(pdf.numPages);
        setPdfError(false);
      } catch (err) {
        console.error("Failed to load PDF:", err);
        setPdfError(true);
      } finally {
        setPdfLoading(false);
      }
    };

    loadPdf();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdfPreviewUrl]);

  // Render PDF page to canvas when the document is loaded or page selection changes
  useEffect(() => {
    if (!pdfDocRef.current || pdfLoading) return;
    // Small delay to ensure canvas is mounted
    const timer = setTimeout(() => {
      renderPdfPage(pdfDocRef.current, sigPosition.page);
    }, 50);
    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdfLoading, sigPosition.page, pdfPageCount]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const renderPdfPage = async (pdf: any, pageChoice: "first" | "last") => {
    const canvas = previewCanvasRef.current;
    if (!canvas) return;

    const pageNum = pageChoice === "first" ? 1 : pdf.numPages;
    const page = await pdf.getPage(pageNum);
    const containerWidth = containerRef.current?.clientWidth || 500;
    const viewport = page.getViewport({ scale: 1 });
    const scale = (containerWidth - 32) / viewport.width;
    const scaledViewport = page.getViewport({ scale });

    canvas.width = scaledViewport.width;
    canvas.height = scaledViewport.height;
    setCanvasSize({ width: scaledViewport.width, height: scaledViewport.height });

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    await page.render({ canvasContext: ctx, viewport: scaledViewport }).promise;
  };

  // Handle click on the PDF preview canvas
  const handleCanvasClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;

    // Convert to percentage of canvas (which maps to page dimensions)
    // PDF y-axis is bottom-up, so we invert
    const xPct = (clickX / canvasSize.width) * 100;
    const yPct = ((canvasSize.height - clickY) / canvasSize.height) * 100;

    setSigPosition((prev) => ({
      ...prev,
      xPercent: Math.max(0, Math.min(xPct, 90)),
      yPercent: Math.max(0, Math.min(yPct, 90)),
    }));
  };

  // Save signature position
  const handleSigSave = async () => {
    setSigSaving(true);
    setSigSaveResult(null);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signaturePosition: sigPosition }),
      });
      const data = await res.json();
      if (res.ok) {
        setSettings((prev) => ({ ...prev, signaturePosition: sigPosition }));
        setSigSaveResult({ success: true, message: "Signature position saved" });
      } else {
        setSigSaveResult({ success: false, message: data.error || "Failed to save" });
      }
    } catch {
      setSigSaveResult({ success: false, message: "Network error" });
    } finally {
      setSigSaving(false);
      setTimeout(() => setSigSaveResult(null), 4000);
    }
  };

  const sigHasChanges = JSON.stringify(sigPosition) !== JSON.stringify(settings.signaturePosition || DEFAULT_SIG_POSITION);

  // Browse a folder
  const browseTo = useCallback(async (targetPath: string = "", type: "invoices" | "tripsheets" = "invoices") => {
    setBrowsing(true);
    try {
      const params = new URLSearchParams();
      if (targetPath) params.set("path", targetPath);
      params.set("type", type);
      const url = `/api/settings/browse?${params.toString()}`;
      const res = await fetch(url);
      const data = await res.json();
      if (res.ok) {
        setBrowseData(data);
      }
    } catch {
      // ignore
    } finally {
      setBrowsing(false);
    }
  }, []);

  // Open browser for a specific target
  const openBrowser = useCallback((target: "invoices" | "tripsheets" = "invoices") => {
    setBrowserTarget(target);
    setBrowserOpen(true);
    const startPath = target === "tripsheets" ? tsSelectedPath : selectedPath;
    browseTo(startPath || "", target);
  }, [selectedPath, tsSelectedPath, browseTo]);

  // Select a folder
  const selectFolder = useCallback(
    async (folderPath: string) => {
      if (browserTarget === "tripsheets") {
        setTsSelectedPath(folderPath);
      } else {
        setSelectedPath(folderPath);
      }
      setBrowserOpen(false);

      // Validate the selection
      try {
        const res = await fetch("/api/settings/validate-folder", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: folderPath, type: browserTarget }),
        });
        const result = await res.json();
        if (browserTarget === "tripsheets") {
          setTsValidation(result);
        } else {
          setValidation(result);
        }
      } catch {
        if (browserTarget === "tripsheets") {
          setTsValidation(null);
        } else {
          setValidation(null);
        }
      }
    },
    [browserTarget]
  );

  // Save settings
  const handleSave = async () => {
    setSaving(true);
    setSaveResult(null);

    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invoiceFolderPath: selectedPath }),
      });
      const data = await res.json();

      if (res.ok) {
        setSettings(data.config);
        setSaveResult({ success: true, message: "Settings saved successfully" });
        setValidation(null);
      } else {
        setSaveResult({
          success: false,
          message: data.error || "Failed to save settings",
        });
      }
    } catch {
      setSaveResult({
        success: false,
        message: "Network error — could not reach server",
      });
    } finally {
      setSaving(false);
      setTimeout(() => setSaveResult(null), 4000);
    }
  };

  // Handle manual path submit
  const handleManualSubmit = () => {
    if (manualPath.trim()) {
      selectFolder(manualPath.trim());
      setManualPath("");
      setShowManualInput(false);
    }
  };

  const hasChanges = selectedPath !== (settings.invoiceFolderPath || "");
  const canSave =
    hasChanges && (selectedPath === "" || (validation?.valid ?? false));

  // Trip sheet folder save
  const handleTsSave = async () => {
    setTsSaving(true);
    setTsSaveResult(null);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tripSheetFolderPath: tsSelectedPath }),
      });
      const data = await res.json();
      if (res.ok) {
        setSettings((prev) => ({ ...prev, tripSheetFolderPath: tsSelectedPath }));
        setTsSaveResult({ success: true, message: "Trip sheet folder saved" });
        setTsValidation(null);
      } else {
        setTsSaveResult({ success: false, message: data.error || "Failed to save" });
      }
    } catch {
      setTsSaveResult({ success: false, message: "Network error" });
    } finally {
      setTsSaving(false);
      setTimeout(() => setTsSaveResult(null), 4000);
    }
  };

  const handleTsManualSubmit = () => {
    if (tsManualPath.trim()) {
      setBrowserTarget("tripsheets");
      selectFolder(tsManualPath.trim());
      setTsManualPath("");
      setTsShowManualInput(false);
    }
  };

  const tsHasChanges = tsSelectedPath !== (settings.tripSheetFolderPath || "");
  const tsCanSave = tsHasChanges && (tsSelectedPath === "" || (tsValidation?.valid ?? false));

  // OneDrive: initiate OAuth flow
  const handleOnedriveConnect = async () => {
    setOnedriveConnecting(true);
    try {
      const res = await fetch("/api/auth/microsoft");
      const data = await res.json();
      if (data.url) {
        window.location.href = data.url;
      } else {
        setOnedriveMessage({ type: "error", text: "Failed to start OAuth flow" });
      }
    } catch {
      setOnedriveMessage({ type: "error", text: "Network error" });
    } finally {
      setOnedriveConnecting(false);
    }
  };

  // OneDrive: disconnect
  const handleOnedriveDisconnect = async () => {
    setOnedriveDisconnecting(true);
    try {
      await fetch("/api/cloud/onedrive", { method: "DELETE" });
      setOnedrive(null);
      setOnedriveMessage({ type: "success", text: "OneDrive disconnected" });
      setTimeout(() => setOnedriveMessage(null), 4000);
    } catch {
      setOnedriveMessage({ type: "error", text: "Failed to disconnect" });
    } finally {
      setOnedriveDisconnecting(false);
    }
  };

  // OneDrive: browse folders
  const browseOnedriveFolders = async (parentId?: string) => {
    setOnedriveBrowsing(true);
    try {
      const params = parentId ? `?parentId=${parentId}` : "";
      const res = await fetch(`/api/cloud/onedrive/folders${params}`);
      const data = await res.json();
      setOnedriveFolders(data.folders || []);
    } catch {
      setOnedriveFolders([]);
    } finally {
      setOnedriveBrowsing(false);
    }
  };

  // OneDrive: open folder browser
  const openOnedriveBrowser = () => {
    setOnedriveBrowserOpen(true);
    setOnedriveBreadcrumbs([]);
    browseOnedriveFolders();
  };

  // OneDrive: navigate into a folder
  const navigateOnedriveFolder = (folder: OneDriveFolder) => {
    setOnedriveBreadcrumbs((prev) => [...prev, { id: folder.id, name: folder.name }]);
    browseOnedriveFolders(folder.id);
  };

  // OneDrive: navigate back to a breadcrumb
  const navigateOnedriveBreadcrumb = (index: number) => {
    if (index < 0) {
      setOnedriveBreadcrumbs([]);
      browseOnedriveFolders();
    } else {
      const crumb = onedriveBreadcrumbs[index];
      setOnedriveBreadcrumbs((prev) => prev.slice(0, index + 1));
      browseOnedriveFolders(crumb.id);
    }
  };

  // OneDrive: select a folder as trip sheet source
  const selectOnedriveFolder = async (folder: OneDriveFolder) => {
    setOnedriveFolderSaving(true);
    try {
      const folderPath = folder.parentReference?.path
        ? `${folder.parentReference.path}/${folder.name}`.replace("/drive/root:", "")
        : `/${folder.name}`;
      const res = await fetch("/api/cloud/onedrive/folders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folderPath, folderItemId: folder.id }),
      });
      if (res.ok) {
        setOnedrive((prev) => prev ? { ...prev, folderPath, folderItemId: folder.id } : prev);
        setOnedriveBrowserOpen(false);
        setOnedriveMessage({ type: "success", text: `Folder set: ${folderPath}` });
        setTimeout(() => setOnedriveMessage(null), 4000);
      } else {
        const data = await res.json();
        setOnedriveMessage({ type: "error", text: data.error || "Failed to set folder" });
      }
    } catch {
      setOnedriveMessage({ type: "error", text: "Network error" });
    } finally {
      setOnedriveFolderSaving(false);
    }
  };

  // Cloud provider label helper
  const getProviderBadge = (providerType: string) => {
    if (providerType === "onedrive") return { icon: "☁️", label: "OneDrive", color: "#0078D4" };
    if (providerType === "gdrive") return { icon: "📁", label: "Google Drive", color: "#34A853" };
    return null;
  };

  if (loading) {
    return (
      <div className="animate-fade-in flex items-center justify-center py-24">
        <div className="w-6 h-6 border-2 border-ink-border border-t-ink-green rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="animate-fade-in max-w-3xl">
      <div className="mb-8">
        <h1 className="font-mono text-2xl font-medium text-ink-black tracking-tight">
          Settings
        </h1>
        <p className="text-sm text-ink-muted mt-1">
          Configure how Signex connects to your invoice and trip sheet files
        </p>
      </div>

      {/* ─── Invoice Folder Path ────────────────────────────────────── */}
      <div className="bg-ink-card border border-ink-border rounded overflow-hidden">
        <div className="px-6 py-4 border-b border-ink-border">
          <div className="flex items-center gap-2">
            <h2 className="font-mono text-sm font-medium text-ink-black uppercase tracking-wide">
              Invoice Folder
            </h2>
            {selectedPath && getProviderBadge(settings.invoiceFolderType) && (
              <span
                className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-mono font-medium rounded-full"
                style={{
                  backgroundColor: getProviderBadge(settings.invoiceFolderType)!.color + '15',
                  color: getProviderBadge(settings.invoiceFolderType)!.color,
                  border: `1px solid ${getProviderBadge(settings.invoiceFolderType)!.color}30`,
                }}
              >
                {getProviderBadge(settings.invoiceFolderType)!.icon} {getProviderBadge(settings.invoiceFolderType)!.label}
              </span>
            )}
          </div>
          <p className="text-xs text-ink-muted mt-1">
            Choose the local, OneDrive, or Google Drive folder containing your PDF invoices
          </p>
        </div>

        <div className="p-6 space-y-5">
          {/* Current selection display */}
          <div className="flex items-center gap-3 p-4 bg-ink-surface border border-ink-border rounded">
            <div className="w-10 h-10 rounded bg-ink-card border border-ink-border flex items-center justify-center shrink-0">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={selectedPath ? "#00C07F" : "#888580"} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              </svg>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-mono text-ink-muted uppercase tracking-wide mb-0.5">
                {selectedPath ? "Selected folder" : "No folder selected"}
              </p>
              <p className="text-sm font-mono text-ink-black truncate">
                {selectedPath || "Using default (./invoices)"}
              </p>
            </div>
            {selectedPath && (
              <button
                onClick={() => {
                  setSelectedPath("");
                  setValidation(null);
                }}
                className="text-xs font-mono text-ink-muted hover:text-ink-red transition-colors px-2 py-1"
                title="Reset to default"
              >
                ✕
              </button>
            )}
          </div>

          {/* Action buttons */}
          <div className="flex flex-wrap gap-3">
            <button
              onClick={() => openBrowser("invoices")}
              className="flex items-center gap-2 px-5 py-3 bg-ink-black text-white font-mono text-sm font-medium rounded hover:bg-ink-black/90 active:scale-[0.98] transition-all"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              </svg>
              Browse Folders
            </button>
            <button
              onClick={() => setShowManualInput(!showManualInput)}
              className="flex items-center gap-2 px-4 py-3 border border-ink-border text-ink-muted font-mono text-sm rounded hover:text-ink-black hover:border-ink-muted-light transition-all"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
              </svg>
              Type Path
            </button>
          </div>

          {/* Cloud quick-select */}
          {cloudRoots.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-mono text-ink-muted uppercase tracking-wide">
                Detected cloud folders
              </p>
              <div className="flex flex-wrap gap-2">
                {cloudRoots.map((root) => (
                  <button
                    key={root.path}
                    onClick={() => {
                      setBrowserTarget("invoices");
                      selectFolder(root.path);
                    }}
                    className="flex items-center gap-2 px-3 py-2 bg-ink-surface border border-ink-border rounded text-xs font-mono text-ink-muted hover:text-ink-black hover:border-ink-muted-light transition-all group"
                  >
                    <span>{root.icon}</span>
                    <span className="group-hover:text-ink-black transition-colors">{root.label}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Manual path input (toggle) */}
          {showManualInput && (
            <div className="flex gap-2 animate-fade-in">
              <input
                type="text"
                value={manualPath}
                onChange={(e) => setManualPath(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleManualSubmit()}
                placeholder="C:\Invoices  or  \\server\share\invoices"
                className="flex-1 px-4 py-2.5 bg-ink-surface border border-ink-border rounded font-mono text-sm text-ink-black placeholder:text-ink-muted-light focus:outline-none focus:border-ink-green focus:ring-1 focus:ring-ink-green/20 transition-colors"
                autoFocus
              />
              <button
                onClick={handleManualSubmit}
                disabled={!manualPath.trim()}
                className="px-4 py-2.5 bg-ink-green text-white font-mono text-sm font-medium rounded hover:bg-ink-green-hover disabled:bg-ink-border disabled:text-ink-muted transition-all"
              >
                Use Path
              </button>
            </div>
          )}

          {/* Validation result */}
          {validation && (
            <div
              className={`rounded p-4 border animate-fade-in ${
                validation.valid
                  ? "bg-ink-green-dim border-ink-green/20"
                  : "bg-ink-red-dim border-ink-red/20"
              }`}
            >
              {validation.valid ? (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#00C07F" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                    <span className="text-sm font-mono font-medium text-ink-green">
                      Folder is valid and accessible
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-3 mt-1">
                    <span className="text-xs font-mono text-ink-muted">
                      📄 {validation.pdfCount} PDF{validation.pdfCount !== 1 ? "s" : ""} found
                    </span>
                    <span className="text-xs font-mono text-ink-muted">
                      {validation.readable ? "✅ Readable" : "❌ Not readable"}
                    </span>
                    <span className="text-xs font-mono text-ink-muted">
                      {validation.writable ? "✅ Writable" : "⚠️ Read-only"}
                    </span>
                  </div>
                </div>
              ) : (
                <div className="flex items-start gap-2">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#E84040" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 mt-0.5">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="15" y1="9" x2="9" y2="15" />
                    <line x1="9" y1="9" x2="15" y2="15" />
                  </svg>
                  <span className="text-sm font-mono text-ink-red">{validation.error}</span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Save actions */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-ink-border bg-ink-surface/50">
          <div className="flex-1">
            {saveResult && (
              <div
                className={`flex items-center gap-2 text-sm font-mono animate-fade-in ${
                  saveResult.success ? "text-ink-green" : "text-ink-red"
                }`}
              >
                {saveResult.success ? "✓" : "✕"} {saveResult.message}
              </div>
            )}
          </div>
          <div className="flex items-center gap-3">
            {hasChanges && (
              <button
                onClick={() => {
                  setSelectedPath(settings.invoiceFolderPath || "");
                  setValidation(null);
                }}
                className="px-4 py-2 text-sm font-mono text-ink-muted hover:text-ink-black transition-colors"
              >
                Cancel
              </button>
            )}
            <button
              onClick={handleSave}
              disabled={!canSave || saving}
              className={`px-5 py-2.5 text-sm font-mono font-medium rounded transition-all ${
                canSave && !saving
                  ? "bg-ink-green text-white hover:bg-ink-green-hover active:scale-[0.98]"
                  : "bg-ink-border text-ink-muted cursor-not-allowed"
              }`}
            >
              {saving ? (
                <span className="flex items-center gap-2">
                  <span className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  Saving…
                </span>
              ) : (
                "Save Changes"
              )}
            </button>
          </div>
        </div>
      </div>

      {/* ─── How It Works ───────────────────────────────────────────── */}
      <div className="mt-6 bg-ink-card border border-ink-border rounded p-6">
        <h3 className="font-mono text-sm font-medium text-ink-black mb-3">
          How it works
        </h3>
        <ul className="space-y-2 text-sm text-ink-muted">
          <li className="flex items-start gap-2">
            <span className="text-ink-green mt-0.5">→</span>
            Place PDF invoice files in the configured folder (local, OneDrive, or Google Drive)
          </li>
          <li className="flex items-start gap-2">
            <span className="text-ink-green mt-0.5">→</span>
            The Invoices page will automatically list all PDFs found
          </li>
          <li className="flex items-start gap-2">
            <span className="text-ink-green mt-0.5">→</span>
            <span>
              After a customer signs, the signed PDF is saved to a{" "}
              <code className="font-mono text-xs bg-ink-surface px-1 py-0.5 rounded">signed/</code>{" "}
              subfolder
            </span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-ink-green mt-0.5">→</span>
            <span>
              Configure a <strong>Trip Sheet Folder</strong> to auto-detect new CSV/Excel files from the cloud
            </span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-ink-amber mt-0.5">→</span>
            <span>
              Cloud folders use the local sync path (OneDrive / Google Drive Desktop must be installed)
            </span>
          </li>
        </ul>
      </div>

      {/* ─── OneDrive Cloud Sync ──────────────────────────────────── */}
      <div className="mt-6 bg-ink-card border border-ink-border rounded overflow-hidden">
        <div className="px-6 py-4 border-b border-ink-border">
          <div className="flex items-center gap-2">
            <h2 className="font-mono text-sm font-medium text-ink-black uppercase tracking-wide">
              OneDrive Cloud Sync
            </h2>
            {onedrive?.connected && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-mono font-medium rounded-full bg-[#0078D4]/10 text-[#0078D4] border border-[#0078D4]/30">
                Connected
              </span>
            )}
          </div>
          <p className="text-xs text-ink-muted mt-1">
            Connect your OneDrive account to sync trip sheet files from the cloud
          </p>
        </div>

        <div className="p-6 space-y-5">
          {/* Message toast */}
          {onedriveMessage && (
            <div
              className={`rounded p-3 border animate-fade-in ${
                onedriveMessage.type === "success"
                  ? "bg-ink-green-dim border-ink-green/20"
                  : "bg-ink-red-dim border-ink-red/20"
              }`}
            >
              <span className={`text-sm font-mono ${onedriveMessage.type === "success" ? "text-ink-green" : "text-ink-red"}`}>
                {onedriveMessage.type === "success" ? "✓" : "✕"} {onedriveMessage.text}
              </span>
            </div>
          )}

          {onedriveLoading ? (
            <div className="flex items-center justify-center py-8">
              <div className="w-5 h-5 border-2 border-ink-border border-t-[#0078D4] rounded-full animate-spin" />
            </div>
          ) : onedrive?.connected ? (
            <>
              {/* Connected state */}
              <div className="flex items-center gap-3 p-4 bg-ink-surface border border-ink-border rounded">
                <div className="w-10 h-10 rounded bg-[#0078D4]/10 border border-[#0078D4]/20 flex items-center justify-center shrink-0">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#0078D4" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" />
                  </svg>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-mono text-ink-black">
                    {onedrive.accountName || onedrive.accountEmail || "OneDrive Account"}
                  </p>
                  {onedrive.accountEmail && onedrive.accountName && (
                    <p className="text-xs font-mono text-ink-muted truncate">{onedrive.accountEmail}</p>
                  )}
                </div>
                <button
                  onClick={handleOnedriveDisconnect}
                  disabled={onedriveDisconnecting}
                  className="text-xs font-mono text-ink-muted hover:text-ink-red transition-colors px-3 py-1.5 border border-ink-border rounded hover:border-ink-red/30"
                >
                  {onedriveDisconnecting ? "..." : "Disconnect"}
                </button>
              </div>

              {/* Folder selection */}
              <div className="space-y-3">
                <p className="text-xs font-mono text-ink-muted uppercase tracking-wide">
                  Trip Sheet Folder
                </p>
                <div className="flex items-center gap-3 p-3 bg-ink-surface border border-ink-border rounded">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={onedrive.folderPath ? "#00C07F" : "#888580"} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                  </svg>
                  <span className="flex-1 text-sm font-mono text-ink-black truncate">
                    {onedrive.folderPath || "No folder selected"}
                  </span>
                  <button
                    onClick={openOnedriveBrowser}
                    className="text-xs font-mono text-[#0078D4] hover:text-[#005a9e] transition-colors px-3 py-1.5 border border-[#0078D4]/30 rounded hover:bg-[#0078D4]/5"
                  >
                    {onedrive.folderPath ? "Change" : "Choose Folder"}
                  </button>
                </div>
              </div>
            </>
          ) : (
            /* Not connected state */
            <div className="text-center py-6 space-y-4">
              <div className="w-14 h-14 rounded-full bg-[#0078D4]/10 border border-[#0078D4]/20 flex items-center justify-center mx-auto">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#0078D4" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" />
                </svg>
              </div>
              <div>
                <p className="text-sm font-mono text-ink-black">Connect OneDrive</p>
                <p className="text-xs text-ink-muted mt-1 max-w-sm mx-auto">
                  Link your Microsoft account to automatically sync trip sheet files from OneDrive
                </p>
              </div>
              <button
                onClick={handleOnedriveConnect}
                disabled={onedriveConnecting}
                className="inline-flex items-center gap-2 px-6 py-3 bg-[#0078D4] text-white font-mono text-sm font-medium rounded hover:bg-[#005a9e] active:scale-[0.98] transition-all disabled:opacity-60"
              >
                {onedriveConnecting ? (
                  <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                ) : (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" />
                  </svg>
                )}
                {onedriveConnecting ? "Connecting..." : "Connect OneDrive"}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* ─── OneDrive Folder Browser Modal ───────────────────────────── */}
      {onedriveBrowserOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/50 backdrop-blur-sm"
            onClick={() => setOnedriveBrowserOpen(false)}
          />
          <div className="relative w-full max-w-xl bg-ink-card border border-ink-border rounded-lg shadow-2xl animate-scale-in flex flex-col max-h-[80vh]">
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-ink-border shrink-0">
              <div>
                <h3 className="font-mono text-sm font-medium text-ink-black">
                  Select OneDrive Folder
                </h3>
                <p className="text-xs text-ink-muted mt-0.5">
                  Choose the folder containing your trip sheet files
                </p>
              </div>
              <button
                onClick={() => setOnedriveBrowserOpen(false)}
                className="w-8 h-8 flex items-center justify-center rounded hover:bg-ink-surface transition-colors text-ink-muted hover:text-ink-black"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>

            {/* Breadcrumbs */}
            <div className="flex items-center gap-1 px-5 py-2.5 border-b border-ink-border overflow-x-auto shrink-0">
              <button
                onClick={() => navigateOnedriveBreadcrumb(-1)}
                className="text-xs font-mono text-ink-muted hover:text-[#0078D4] transition-colors shrink-0 px-1"
              >
                OneDrive
              </button>
              {onedriveBreadcrumbs.map((crumb, i) => (
                <span key={crumb.id} className="flex items-center gap-1 shrink-0">
                  <span className="text-xs text-ink-muted-light">/</span>
                  <button
                    onClick={() => navigateOnedriveBreadcrumb(i)}
                    className={`text-xs font-mono px-1 py-0.5 rounded transition-colors ${
                      i === onedriveBreadcrumbs.length - 1
                        ? "text-ink-black font-medium bg-ink-surface"
                        : "text-ink-muted hover:text-[#0078D4]"
                    }`}
                  >
                    {crumb.name}
                  </button>
                </span>
              ))}
            </div>

            {/* Loading */}
            {onedriveBrowsing && (
              <div className="flex items-center justify-center py-12">
                <div className="w-5 h-5 border-2 border-ink-border border-t-[#0078D4] rounded-full animate-spin" />
              </div>
            )}

            {/* Folder list */}
            {!onedriveBrowsing && (
              <div className="flex-1 overflow-y-auto min-h-0">
                {/* Go up */}
                {onedriveBreadcrumbs.length > 0 && (
                  <button
                    onClick={() => navigateOnedriveBreadcrumb(onedriveBreadcrumbs.length - 2)}
                    className="flex items-center gap-3 w-full px-5 py-3 text-left hover:bg-ink-surface transition-colors border-b border-ink-border"
                  >
                    <div className="w-8 h-8 rounded bg-ink-surface flex items-center justify-center shrink-0">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#888580" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="15 18 9 12 15 6" />
                      </svg>
                    </div>
                    <span className="text-sm font-mono text-ink-muted">..</span>
                    <span className="text-xs text-ink-muted-light ml-auto">Go up</span>
                  </button>
                )}

                {onedriveFolders.length === 0 && !onedriveBrowsing && (
                  <div className="py-12 text-center">
                    <p className="text-sm font-mono text-ink-muted">No subfolders found</p>
                    <p className="text-xs text-ink-muted-light mt-1">
                      Select the current folder using the button below
                    </p>
                  </div>
                )}

                {onedriveFolders.map((folder) => (
                  <button
                    key={folder.id}
                    onClick={() => navigateOnedriveFolder(folder)}
                    className="flex items-center gap-3 w-full px-5 py-3 text-left hover:bg-ink-surface transition-colors border-b border-ink-border/50 group"
                  >
                    <div className="w-8 h-8 rounded bg-ink-surface flex items-center justify-center shrink-0">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#0078D4" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                      </svg>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-mono text-ink-black truncate group-hover:text-[#0078D4] transition-colors">
                        {folder.name}
                      </p>
                    </div>
                    {folder.folder && (
                      <span className="text-[10px] font-mono text-ink-muted shrink-0">
                        {folder.folder.childCount} items
                      </span>
                    )}
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#B8B5B0" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
                      <polyline points="9 18 15 12 9 6" />
                    </svg>
                  </button>
                ))}
              </div>
            )}

            {/* Footer with select button */}
            <div className="flex items-center justify-between px-5 py-4 border-t border-ink-border shrink-0 bg-ink-surface/50">
              <span className="text-xs font-mono text-ink-muted truncate mr-3">
                /{onedriveBreadcrumbs.map((c) => c.name).join("/")}
              </span>
              <button
                onClick={() => {
                  const lastCrumb = onedriveBreadcrumbs[onedriveBreadcrumbs.length - 1];
                  if (lastCrumb) {
                    selectOnedriveFolder({ id: lastCrumb.id, name: lastCrumb.name } as OneDriveFolder);
                  }
                }}
                disabled={onedriveBreadcrumbs.length === 0 || onedriveFolderSaving}
                className={`px-4 py-2 text-xs font-mono font-medium rounded transition-all ${
                  onedriveBreadcrumbs.length > 0 && !onedriveFolderSaving
                    ? "bg-ink-green text-white hover:bg-ink-green-hover active:scale-[0.98]"
                    : "bg-ink-border text-ink-muted cursor-not-allowed"
                }`}
              >
                {onedriveFolderSaving ? "Saving..." : "Select This Folder"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── Trip Sheet Folder ──────────────────────────────────── */}
      <div className="mt-6 bg-ink-card border border-ink-border rounded overflow-hidden">
        <div className="px-6 py-4 border-b border-ink-border">
          <div className="flex items-center gap-2">
            <h2 className="font-mono text-sm font-medium text-ink-black uppercase tracking-wide">
              Trip Sheet Folder
            </h2>
            {tsSelectedPath && getProviderBadge(settings.tripSheetFolderType) && (
              <span
                className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-mono font-medium rounded-full"
                style={{
                  backgroundColor: getProviderBadge(settings.tripSheetFolderType)!.color + '15',
                  color: getProviderBadge(settings.tripSheetFolderType)!.color,
                  border: `1px solid ${getProviderBadge(settings.tripSheetFolderType)!.color}30`,
                }}
              >
                {getProviderBadge(settings.tripSheetFolderType)!.icon} {getProviderBadge(settings.tripSheetFolderType)!.label}
              </span>
            )}
          </div>
          <p className="text-xs text-ink-muted mt-1">
            Link a OneDrive or Google Drive folder to auto-detect trip sheet files (CSV/Excel)
          </p>
        </div>

        <div className="p-6 space-y-5">
          {/* Current selection display */}
          <div className="flex items-center gap-3 p-4 bg-ink-surface border border-ink-border rounded">
            <div className="w-10 h-10 rounded bg-ink-card border border-ink-border flex items-center justify-center shrink-0">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={tsSelectedPath ? "#00C07F" : "#888580"} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <line x1="16" y1="13" x2="8" y2="13" />
                <line x1="16" y1="17" x2="8" y2="17" />
              </svg>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-mono text-ink-muted uppercase tracking-wide mb-0.5">
                {tsSelectedPath ? "Selected folder" : "No folder configured"}
              </p>
              <p className="text-sm font-mono text-ink-black truncate">
                {tsSelectedPath || "Trip sheets must be uploaded manually"}
              </p>
            </div>
            {tsSelectedPath && (
              <button
                onClick={() => {
                  setTsSelectedPath("");
                  setTsValidation(null);
                }}
                className="text-xs font-mono text-ink-muted hover:text-ink-red transition-colors px-2 py-1"
                title="Remove folder"
              >
                ✕
              </button>
            )}
          </div>

          {/* Action buttons */}
          <div className="flex flex-wrap gap-3">
            <button
              onClick={() => openBrowser("tripsheets")}
              className="flex items-center gap-2 px-5 py-3 bg-ink-black text-white font-mono text-sm font-medium rounded hover:bg-ink-black/90 active:scale-[0.98] transition-all"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              </svg>
              Browse Folders
            </button>
            <button
              onClick={() => setTsShowManualInput(!tsShowManualInput)}
              className="flex items-center gap-2 px-4 py-3 border border-ink-border text-ink-muted font-mono text-sm rounded hover:text-ink-black hover:border-ink-muted-light transition-all"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
              </svg>
              Type Path
            </button>
          </div>

          {/* Cloud quick-select */}
          {cloudRoots.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-mono text-ink-muted uppercase tracking-wide">
                Detected cloud folders
              </p>
              <div className="flex flex-wrap gap-2">
                {cloudRoots.map((root) => (
                  <button
                    key={root.path}
                    onClick={() => {
                      setBrowserTarget("tripsheets");
                      selectFolder(root.path);
                    }}
                    className="flex items-center gap-2 px-3 py-2 bg-ink-surface border border-ink-border rounded text-xs font-mono text-ink-muted hover:text-ink-black hover:border-ink-muted-light transition-all group"
                  >
                    <span>{root.icon}</span>
                    <span className="group-hover:text-ink-black transition-colors">{root.label}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Manual path input (toggle) */}
          {tsShowManualInput && (
            <div className="flex gap-2 animate-fade-in">
              <input
                type="text"
                value={tsManualPath}
                onChange={(e) => setTsManualPath(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleTsManualSubmit()}
                placeholder="C:\TripSheets  or  OneDrive path"
                className="flex-1 px-4 py-2.5 bg-ink-surface border border-ink-border rounded font-mono text-sm text-ink-black placeholder:text-ink-muted-light focus:outline-none focus:border-ink-green focus:ring-1 focus:ring-ink-green/20 transition-colors"
                autoFocus
              />
              <button
                onClick={handleTsManualSubmit}
                disabled={!tsManualPath.trim()}
                className="px-4 py-2.5 bg-ink-green text-white font-mono text-sm font-medium rounded hover:bg-ink-green-hover disabled:bg-ink-border disabled:text-ink-muted transition-all"
              >
                Use Path
              </button>
            </div>
          )}

          {/* Validation result */}
          {tsValidation && (
            <div
              className={`rounded p-4 border animate-fade-in ${
                tsValidation.valid
                  ? "bg-ink-green-dim border-ink-green/20"
                  : "bg-ink-red-dim border-ink-red/20"
              }`}
            >
              {tsValidation.valid ? (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#00C07F" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                    <span className="text-sm font-mono font-medium text-ink-green">
                      Folder is valid and accessible
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-3 mt-1">
                    <span className="text-xs font-mono text-ink-muted">
                      📄 {tsValidation.fileCount} file{tsValidation.fileCount !== 1 ? "s" : ""} found
                    </span>
                    <span className="text-xs font-mono text-ink-muted">
                      {tsValidation.readable ? "✅ Readable" : "❌ Not readable"}
                    </span>
                  </div>
                </div>
              ) : (
                <div className="flex items-start gap-2">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#E84040" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 mt-0.5">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="15" y1="9" x2="9" y2="15" />
                    <line x1="9" y1="9" x2="15" y2="15" />
                  </svg>
                  <span className="text-sm font-mono text-ink-red">{tsValidation.error}</span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Save actions */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-ink-border bg-ink-surface/50">
          <div className="flex-1">
            {tsSaveResult && (
              <div
                className={`flex items-center gap-2 text-sm font-mono animate-fade-in ${
                  tsSaveResult.success ? "text-ink-green" : "text-ink-red"
                }`}
              >
                {tsSaveResult.success ? "✓" : "✕"} {tsSaveResult.message}
              </div>
            )}
          </div>
          <div className="flex items-center gap-3">
            {tsHasChanges && (
              <button
                onClick={() => {
                  setTsSelectedPath(settings.tripSheetFolderPath || "");
                  setTsValidation(null);
                }}
                className="px-4 py-2 text-sm font-mono text-ink-muted hover:text-ink-black transition-colors"
              >
                Cancel
              </button>
            )}
            <button
              onClick={handleTsSave}
              disabled={!tsCanSave || tsSaving}
              className={`px-5 py-2.5 text-sm font-mono font-medium rounded transition-all ${
                tsCanSave && !tsSaving
                  ? "bg-ink-green text-white hover:bg-ink-green-hover active:scale-[0.98]"
                  : "bg-ink-border text-ink-muted cursor-not-allowed"
              }`}
            >
              {tsSaving ? (
                <span className="flex items-center gap-2">
                  <span className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  Saving…
                </span>
              ) : (
                "Save Changes"
              )}
            </button>
          </div>
        </div>
      </div>

      {/* ─── Signature Placement ──────────────────────────────────── */}
      <div className="mt-6 bg-ink-card border border-ink-border rounded overflow-hidden">
        <div className="px-6 py-4 border-b border-ink-border">
          <h2 className="font-mono text-sm font-medium text-ink-black uppercase tracking-wide">
            Signature Placement
          </h2>
          <p className="text-xs text-ink-muted mt-1">
            Click on the PDF preview to set where the signature will appear on signed invoices
          </p>
        </div>

        <div className="p-6 space-y-5">
          {/* Page selector */}
          {pdfPageCount > 1 && (
            <div className="flex items-center gap-2">
              <span className="text-xs font-mono text-ink-muted uppercase tracking-wide">
                Place on:
              </span>
              <div className="flex rounded border border-ink-border overflow-hidden">
                <button
                  onClick={() => setSigPosition((p) => ({ ...p, page: "first" }))}
                  className={`px-4 py-1.5 text-xs font-mono transition-colors ${
                    sigPosition.page === "first"
                      ? "bg-ink-green text-white"
                      : "bg-ink-surface text-ink-muted hover:text-ink-black"
                  }`}
                >
                  First Page
                </button>
                <button
                  onClick={() => setSigPosition((p) => ({ ...p, page: "last" }))}
                  className={`px-4 py-1.5 text-xs font-mono transition-colors border-l border-ink-border ${
                    sigPosition.page === "last"
                      ? "bg-ink-green text-white"
                      : "bg-ink-surface text-ink-muted hover:text-ink-black"
                  }`}
                >
                  Last Page
                </button>
              </div>
              <span className="text-xs text-ink-muted ml-2">
                ({pdfPageCount} pages)
              </span>
            </div>
          )}

          {/* Signature width */}
          <div className="flex items-center gap-3">
            <span className="text-xs font-mono text-ink-muted uppercase tracking-wide shrink-0">
              Sig width:
            </span>
            <input
              type="range"
              min="10"
              max="50"
              value={sigPosition.widthPercent}
              onChange={(e) =>
                setSigPosition((p) => ({ ...p, widthPercent: Number(e.target.value) }))
              }
              className="flex-1 max-w-[200px] accent-[#00C07F]"
            />
            <span className="text-xs font-mono text-ink-muted w-10 text-right">
              {sigPosition.widthPercent}%
            </span>
          </div>

          {/* PDF Preview with click-to-place */}
          <div ref={containerRef} className="relative">
            {/* Canvas is ALWAYS mounted so the ref is available for rendering */}
            <div
              className={`relative inline-block cursor-crosshair border border-ink-border rounded overflow-hidden ${
                canvasSize.width > 0 && pdfPreviewUrl ? "" : "hidden"
              }`}
              onClick={handleCanvasClick}
              style={canvasSize.width > 0 ? { width: canvasSize.width, height: canvasSize.height } : undefined}
            >
              <canvas
                ref={previewCanvasRef}
                className="block"
              />

              {/* Signature placement overlay */}
              {canvasSize.width > 0 && (
                <div
                  className="absolute pointer-events-none border-2 border-[#00C07F] bg-[#00C07F]/10 rounded transition-all duration-150"
                  style={{
                    left: `${sigPosition.xPercent}%`,
                    bottom: `${sigPosition.yPercent}%`,
                    width: `${sigPosition.widthPercent}%`,
                    height: `${sigPosition.widthPercent * 0.45}%`,
                  }}
                >
                  <div className="absolute inset-0 flex items-center justify-center">
                    <span className="text-[10px] font-mono text-[#00C07F] font-medium bg-white/80 px-1.5 py-0.5 rounded">
                      ✍ SIGNATURE
                    </span>
                  </div>
                  {/* Corner dots */}
                  <div className="absolute -top-1 -left-1 w-2 h-2 bg-[#00C07F] rounded-full" />
                  <div className="absolute -top-1 -right-1 w-2 h-2 bg-[#00C07F] rounded-full" />
                  <div className="absolute -bottom-1 -left-1 w-2 h-2 bg-[#00C07F] rounded-full" />
                  <div className="absolute -bottom-1 -right-1 w-2 h-2 bg-[#00C07F] rounded-full" />
                </div>
              )}
            </div>

            {/* Loading state */}
            {pdfLoading && (
              <div className="flex items-center justify-center py-16 bg-ink-surface rounded border border-ink-border">
                <div className="w-5 h-5 border-2 border-ink-border border-t-ink-green rounded-full animate-spin" />
                <span className="ml-3 text-xs font-mono text-ink-muted">Loading PDF preview…</span>
              </div>
            )}

            {/* Empty state — no invoices available */}
            {!pdfPreviewUrl && !pdfLoading && (
              <div className="flex items-center justify-center py-16 bg-ink-surface rounded border-2 border-dashed border-ink-border text-center">
                <div>
                  <p className="text-sm font-mono text-ink-muted">No invoice PDFs found</p>
                  <p className="text-xs text-ink-muted mt-1">
                    Upload invoices to the configured folder, then return here to set signature position
                  </p>
                </div>
              </div>
            )}

            {/* Error state — PDF failed to load */}
            {pdfError && !pdfLoading && pdfPreviewUrl && canvasSize.width === 0 && (
              <div className="flex items-center justify-center py-16 bg-ink-surface rounded border-2 border-dashed border-ink-red/20 text-center">
                <div>
                  <p className="text-sm font-mono text-ink-red">Failed to load PDF preview</p>
                  <p className="text-xs text-ink-muted mt-1 mb-3">
                    The invoice file may be missing or inaccessible
                  </p>
                  <button
                    onClick={() => {
                      setPdfError(false);
                      setPdfLoading(true);
                      // Re-trigger the load
                      const url = pdfPreviewUrl;
                      setPdfPreviewUrl(null);
                      setTimeout(() => setPdfPreviewUrl(url), 100);
                    }}
                    className="px-4 py-2 text-xs font-mono bg-ink-card border border-ink-border rounded hover:bg-ink-surface transition-colors"
                  >
                    Retry
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Position readout */}
          {canvasSize.width > 0 && (
            <div className="flex flex-wrap items-center gap-4 text-xs font-mono text-ink-muted">
              <span>
                X: <strong className="text-ink-black">{sigPosition.xPercent.toFixed(1)}%</strong>
              </span>
              <span>
                Y: <strong className="text-ink-black">{sigPosition.yPercent.toFixed(1)}%</strong>
              </span>
              <span>
                Page: <strong className="text-ink-black">{sigPosition.page}</strong>
              </span>
              <button
                onClick={() => setSigPosition(DEFAULT_SIG_POSITION)}
                className="ml-auto text-ink-muted hover:text-ink-black transition-colors"
              >
                Reset to default
              </button>
            </div>
          )}
        </div>

        {/* Save actions */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-ink-border bg-ink-surface/50">
          <div className="flex-1">
            {sigSaveResult && (
              <div
                className={`flex items-center gap-2 text-sm font-mono animate-fade-in ${
                  sigSaveResult.success ? "text-ink-green" : "text-ink-red"
                }`}
              >
                {sigSaveResult.success ? "✓" : "✕"} {sigSaveResult.message}
              </div>
            )}
          </div>
          <div className="flex items-center gap-3">
            {sigHasChanges && (
              <button
                onClick={() => setSigPosition(settings.signaturePosition || DEFAULT_SIG_POSITION)}
                className="px-4 py-2 text-sm font-mono text-ink-muted hover:text-ink-black transition-colors"
              >
                Cancel
              </button>
            )}
            <button
              onClick={handleSigSave}
              disabled={!sigHasChanges || sigSaving}
              className={`px-5 py-2.5 text-sm font-mono font-medium rounded transition-all ${
                sigHasChanges && !sigSaving
                  ? "bg-ink-green text-white hover:bg-ink-green-hover active:scale-[0.98]"
                  : "bg-ink-border text-ink-muted cursor-not-allowed"
              }`}
            >
              {sigSaving ? (
                <span className="flex items-center gap-2">
                  <span className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  Saving…
                </span>
              ) : (
                "Save Position"
              )}
            </button>
          </div>
        </div>
      </div>

      {/* ─── Folder Browser Modal ───────────────────────────────────── */}
      {browserOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/50 backdrop-blur-sm"
            onClick={() => setBrowserOpen(false)}
          />

          {/* Modal */}
          <div className="relative w-full max-w-xl bg-ink-card border border-ink-border rounded-lg shadow-2xl animate-scale-in flex flex-col max-h-[80vh]">
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-ink-border shrink-0">
              <div>
                <h3 className="font-mono text-sm font-medium text-ink-black">
                  Browse Folders
                </h3>
                <p className="text-xs text-ink-muted mt-0.5">
                  Navigate to the folder containing your {browserTarget === "tripsheets" ? "CSV/Excel trip sheets" : "invoice PDFs"}
                </p>
              </div>
              <button
                onClick={() => setBrowserOpen(false)}
                className="w-8 h-8 flex items-center justify-center rounded hover:bg-ink-surface transition-colors text-ink-muted hover:text-ink-black"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>

            {/* Breadcrumbs */}
            {browseData && browseData.breadcrumbs.length > 0 && (
              <div className="flex items-center gap-1 px-5 py-2.5 border-b border-ink-border overflow-x-auto shrink-0">
                <button
                  onClick={() => browseTo("", browserTarget)}
                  className="text-xs font-mono text-ink-muted hover:text-ink-green transition-colors shrink-0 px-1"
                >
                  💻
                </button>
                {browseData.breadcrumbs.map((crumb, i) => (
                  <span key={crumb.path} className="flex items-center gap-1 shrink-0">
                    <span className="text-xs text-ink-muted-light">/</span>
                    <button
                      onClick={() => browseTo(crumb.path, browserTarget)}
                      className={`text-xs font-mono px-1 py-0.5 rounded transition-colors ${
                        i === browseData.breadcrumbs.length - 1
                          ? "text-ink-black font-medium bg-ink-surface"
                          : "text-ink-muted hover:text-ink-green"
                      }`}
                    >
                      {crumb.name}
                    </button>
                  </span>
                ))}
              </div>
            )}

            {/* Current folder info bar */}
            {browseData?.current && (
              <div className="flex items-center justify-between px-5 py-2 border-b border-ink-border bg-ink-surface/50 shrink-0">
                <span className="text-xs font-mono text-ink-muted truncate flex-1 mr-3">
                  {browseData.current}
                </span>
                <div className="flex items-center gap-3 shrink-0">
                  {browseData.currentPdfCount !== undefined &&
                    browseData.currentPdfCount > 0 && (
                      <span className="badge-signed text-[10px]">
                        {browseData.currentPdfCount} {browseData.fileLabel || (browserTarget === "tripsheets" ? "files" : "PDF" + (browseData.currentPdfCount !== 1 ? "s" : ""))}
                      </span>
                    )}
                  <button
                    onClick={() => selectFolder(browseData.current)}
                    className="px-3 py-1.5 bg-ink-green text-white text-xs font-mono font-medium rounded hover:bg-ink-green-hover active:scale-[0.98] transition-all"
                  >
                    Select This Folder
                  </button>
                </div>
              </div>
            )}

            {/* Loading */}
            {browsing && (
              <div className="flex items-center justify-center py-12">
                <div className="w-5 h-5 border-2 border-ink-border border-t-ink-green rounded-full animate-spin" />
              </div>
            )}

            {/* Folder list */}
            {!browsing && browseData && (
              <div className="flex-1 overflow-y-auto min-h-0">
                {/* Go up */}
                {browseData.parent && (
                  <button
                    onClick={() => browseTo(browseData.parent!, browserTarget)}
                    className="flex items-center gap-3 w-full px-5 py-3 text-left hover:bg-ink-surface transition-colors border-b border-ink-border"
                  >
                    <div className="w-8 h-8 rounded bg-ink-surface flex items-center justify-center shrink-0">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#888580" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="15 18 9 12 15 6" />
                      </svg>
                    </div>
                    <span className="text-sm font-mono text-ink-muted">..</span>
                    <span className="text-xs text-ink-muted-light ml-auto">
                      Go up
                    </span>
                  </button>
                )}

                {browseData.entries.length === 0 && (
                  <div className="py-12 text-center">
                    <p className="text-sm font-mono text-ink-muted">
                      No subfolders found
                    </p>
                    {browseData.current && (
                      <p className="text-xs text-ink-muted-light mt-1">
                        You can still select this folder using the button above
                      </p>
                    )}
                  </div>
                )}

                {browseData.entries.map((entry) => (
                  <button
                    key={entry.path}
                    onClick={() => browseTo(entry.path, browserTarget)}
                    className="flex items-center gap-3 w-full px-5 py-3 text-left hover:bg-ink-surface transition-colors border-b border-ink-border/50 group"
                  >
                    <div
                      className={`w-8 h-8 rounded flex items-center justify-center shrink-0 ${
                        (entry.pdfCount ?? 0) > 0
                          ? "bg-ink-green-dim"
                          : "bg-ink-surface"
                      }`}
                    >
                      <svg
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke={(entry.pdfCount ?? 0) > 0 ? "#00C07F" : "#888580"}
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                      </svg>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-mono text-ink-black truncate group-hover:text-ink-green transition-colors">
                        {entry.name}
                      </p>
                    </div>
                    {(entry.pdfCount ?? 0) > 0 && (
                      <span className="badge-signed text-[10px] shrink-0">
                        {entry.pdfCount} {browseData?.fileLabel || (browserTarget === "tripsheets" ? "files" : "PDF" + (entry.pdfCount !== 1 ? "s" : ""))}
                      </span>
                    )}
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="#B8B5B0"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="shrink-0"
                    >
                      <polyline points="9 18 15 12 9 6" />
                    </svg>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
