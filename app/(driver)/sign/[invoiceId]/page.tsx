"use client";

import { useParams, useRouter } from "next/navigation";
import { useRef, useState, useEffect, useCallback } from "react";

interface StopData {
  id: string;
  stopNumber: number;
  invoiceNumber: string;
  customerName: string;
  address: string;
  nop: number;
  invoiceFile?: string;
  status: string;
}

export default function SignInvoicePage() {
  const params = useParams();
  const router = useRouter();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [hasSignature, setHasSignature] = useState(false);
  const [status, setStatus] = useState<"idle" | "loading" | "saving" | "done" | "error">("loading");
  const [stop, setStop] = useState<StopData | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [contactHasEmail, setContactHasEmail] = useState(false);
  const [signedStopId, setSignedStopId] = useState<string | null>(null);
  const [emailStatus, setEmailStatus] = useState<"idle" | "sending" | "sent" | "failed">("idle");

  // Fetch stop data to get invoice filename
  const fetchStopData = useCallback(async () => {
    try {
      const stored = localStorage.getItem("signex-driver");
      if (!stored) {
        setErrorMessage("No driver selected. Please select a driver first.");
        setStatus("error");
        return;
      }
      const driver = JSON.parse(stored);
      const res = await fetch(`/api/trip-sheet/stops?driverId=${driver.id}`);
      const data = await res.json();

      if (!res.ok) {
        setErrorMessage(data.error || "Failed to load stops");
        setStatus("error");
        return;
      }

      const stopId = params.invoiceId as string;
      const foundStop = (data.stops || []).find((s: StopData) => s.id === stopId);
      if (!foundStop) {
        setErrorMessage("Stop not found. It may have already been signed.");
        setStatus("error");
        return;
      }

      if (foundStop.status === "SIGNED") {
        setErrorMessage("This invoice has already been signed.");
        setStatus("error");
        return;
      }

      setStop(foundStop);
      setStatus("idle");
    } catch {
      setErrorMessage("Failed to connect to server");
      setStatus("error");
    }
  }, [params.invoiceId]);

  useEffect(() => {
    fetchStopData();
  }, [fetchStopData]);

  // Canvas drawing logic
  useEffect(() => {
    if (status !== "idle") return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      ctx.scale(dpr, dpr);
      ctx.strokeStyle = "#0F0F0F";
      ctx.lineWidth = 2.5;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
    };

    resize();
    window.addEventListener("resize", resize);

    let drawing = false;
    let lastX = 0;
    let lastY = 0;

    const getPos = (e: MouseEvent | TouchEvent) => {
      const rect = canvas.getBoundingClientRect();
      const clientX = "touches" in e ? e.touches[0].clientX : e.clientX;
      const clientY = "touches" in e ? e.touches[0].clientY : e.clientY;
      return { x: clientX - rect.left, y: clientY - rect.top };
    };

    const start = (e: MouseEvent | TouchEvent) => {
      e.preventDefault();
      drawing = true;
      const pos = getPos(e);
      lastX = pos.x;
      lastY = pos.y;
      setIsDrawing(true);
      setHasSignature(true);
    };

    const move = (e: MouseEvent | TouchEvent) => {
      if (!drawing) return;
      e.preventDefault();
      const pos = getPos(e);
      ctx.beginPath();
      ctx.moveTo(lastX, lastY);
      ctx.lineTo(pos.x, pos.y);
      ctx.stroke();
      lastX = pos.x;
      lastY = pos.y;
    };

    const end = () => {
      drawing = false;
      setIsDrawing(false);
    };

    canvas.addEventListener("mousedown", start);
    canvas.addEventListener("mousemove", move);
    canvas.addEventListener("mouseup", end);
    canvas.addEventListener("touchstart", start, { passive: false });
    canvas.addEventListener("touchmove", move, { passive: false });
    canvas.addEventListener("touchend", end);

    return () => {
      window.removeEventListener("resize", resize);
      canvas.removeEventListener("mousedown", start);
      canvas.removeEventListener("mousemove", move);
      canvas.removeEventListener("mouseup", end);
      canvas.removeEventListener("touchstart", start);
      canvas.removeEventListener("touchmove", move);
      canvas.removeEventListener("touchend", end);
    };
  }, [status]);

  const handleClear = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    setHasSignature(false);
  };

  const handleConfirm = async () => {
    if (!stop || !canvasRef.current || !hasSignature) return;

    setStatus("saving");

    try {
      // Export canvas as PNG data URL
      const signatureImage = canvasRef.current.toDataURL("image/png");

      if (stop.invoiceFile) {
        // PDF exists — embed signature on PDF and save to signed folder
        const res = await fetch(
          `/api/invoices/${encodeURIComponent(stop.invoiceFile)}`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              signatureImage,
              stopId: stop.id,
              signerName: stop.customerName !== "Unknown" ? stop.customerName : undefined,
            }),
          }
        );

        const data = await res.json();

        if (!res.ok) {
          setErrorMessage(data.error || "Failed to save signed invoice");
          setStatus("error");
          return;
        }

        setContactHasEmail(!!data.contactHasEmail);
        setSignedStopId(stop.id);
      } else {
        // No PDF linked — just update the stop status to SIGNED
        const res = await fetch("/api/trip-sheet/stops", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            stopId: stop.id,
            status: "SIGNED",
          }),
        });

        const data = await res.json();

        if (!res.ok) {
          setErrorMessage(data.error || "Failed to update stop status");
          setStatus("error");
          return;
        }

        setContactHasEmail(!!data.contactHasEmail);
        setSignedStopId(stop.id);
      }

      setStatus("done");
    } catch {
      setErrorMessage("Failed to connect to server. Please try again.");
      setStatus("error");
    }
  };

  // ─── Loading state ────────────────────────────────────────────
  if (status === "loading") {
    return (
      <div className="flex-1 flex flex-col items-center justify-center px-6">
        <div className="w-8 h-8 border-2 border-ink-border border-t-ink-green rounded-full animate-spin mb-4" />
        <p className="text-sm font-mono text-ink-muted">Loading invoice…</p>
      </div>
    );
  }

  // ─── Error state ──────────────────────────────────────────────
  if (status === "error") {
    return (
      <div className="flex-1 flex flex-col items-center justify-center px-6">
        <div className="w-16 h-16 rounded-full bg-ink-red-dim flex items-center justify-center mb-4">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#E84040" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <line x1="15" y1="9" x2="9" y2="15" />
            <line x1="9" y1="9" x2="15" y2="15" />
          </svg>
        </div>
        <p className="font-mono text-sm text-ink-red mb-2 text-center">{errorMessage}</p>
        <button
          onClick={() => router.push("/run")}
          className="mt-4 px-4 py-2 text-xs font-mono bg-ink-card border border-ink-border rounded hover:bg-ink-surface transition-colors"
        >
          ← Back to Run Sheet
        </button>
      </div>
    );
  }

  const handleSendEmail = async () => {
    if (!signedStopId) return;
    setEmailStatus("sending");
    try {
      const stored = localStorage.getItem("signex-driver");
      const driverName = stored ? JSON.parse(stored).name : "Driver";
      const res = await fetch(`/api/invoices/${signedStopId}/notify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ driverName }),
      });
      const data = await res.json();
      if (data.success) {
        setEmailStatus("sent");
      } else {
        setEmailStatus("failed");
      }
    } catch {
      setEmailStatus("failed");
    }
  };

  // ─── Success state ────────────────────────────────────────────
  if (status === "done") {
    return (
      <div className="flex-1 flex flex-col items-center justify-center px-6 animate-scale-in">
        <div className="w-16 h-16 rounded-full bg-ink-green-dim flex items-center justify-center mb-4">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#00C07F" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </div>
        <h2 className="font-mono text-xl font-medium text-ink-black mb-1">Signed & Saved</h2>
        <p className="text-sm text-ink-muted text-center mb-4">
          Invoice signed and saved to signed folder.
        </p>

        {contactHasEmail ? (
          <button
            onClick={handleSendEmail}
            disabled={emailStatus === "sending" || emailStatus === "sent"}
            className={`px-5 py-2.5 text-sm font-mono rounded transition-all ${
              emailStatus === "sent"
                ? "bg-ink-green-dim text-ink-green cursor-default"
                : emailStatus === "failed"
                ? "bg-red-50 text-ink-red border border-ink-red/20 hover:bg-red-100"
                : emailStatus === "sending"
                ? "bg-ink-surface text-ink-muted cursor-wait"
                : "bg-ink-green text-white hover:bg-ink-green-hover active:scale-[0.98]"
            }`}
          >
            {emailStatus === "idle" && "Send confirmation to customer"}
            {emailStatus === "sending" && "Sending..."}
            {emailStatus === "sent" && "✓ Email sent"}
            {emailStatus === "failed" && "Failed — tap to retry"}
          </button>
        ) : (
          <p className="text-xs text-ink-muted font-mono">No email on file for this customer</p>
        )}

        <button
          onClick={() => router.push("/run")}
          className="mt-4 px-4 py-2 text-xs font-mono text-ink-muted hover:text-ink-black transition-colors"
        >
          ← Back to run
        </button>
      </div>
    );
  }

  // ─── Main signing view ────────────────────────────────────────
  return (
    <div className="flex-1 flex flex-col animate-fade-in">
      {/* Invoice info bar */}
      <div className="bg-ink-card border-b border-ink-border px-4 py-3 flex items-center justify-between">
        <div>
          <p className="font-mono text-sm font-medium text-ink-black">
            {stop?.invoiceNumber}
          </p>
          <p className="text-xs text-ink-muted">
            {stop?.customerName}
            {stop && stop.nop > 0 ? ` · ${stop.nop} parcels` : ""}
          </p>
        </div>
        <button
          onClick={() => router.push("/run")}
          className="text-xs font-mono text-ink-muted hover:text-ink-black transition-colors"
        >
          Cancel
        </button>
      </div>

      {/* PDF preview area */}
      <div className="flex-1 bg-ink-surface border-b border-ink-border min-h-[200px] relative">
        {stop?.invoiceFile ? (
          <iframe
            src={`/api/invoices/${encodeURIComponent(stop.invoiceFile)}`}
            className="w-full h-full min-h-[300px] border-0"
            title={`Invoice ${stop.invoiceNumber}`}
            style={{ minHeight: "40vh" }}
          />
        ) : (
          <div className="flex items-center justify-center h-full p-8">
            <div className="text-center">
              <p className="font-mono text-sm text-ink-muted">No PDF file linked</p>
              <p className="text-xs text-ink-muted mt-1">
                This invoice doesn&apos;t have a matching PDF file
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Signature area — sticky at bottom */}
      <div className="bg-ink-card border-t border-ink-border p-4">
        <p className="text-xs font-mono text-ink-muted uppercase tracking-wide mb-3">
          Customer Signature
        </p>

        <div className="relative border-2 border-dashed border-ink-border rounded bg-ink-surface">
          {/* Baseline */}
          <div className="absolute bottom-8 left-4 right-4 border-b border-ink-border" />

          <canvas
            ref={canvasRef}
            className="w-full rounded cursor-crosshair"
            style={{ height: "120px", touchAction: "none" }}
          />

          {!hasSignature && (
            <p className="absolute inset-0 flex items-center justify-center text-ink-muted text-sm font-mono pointer-events-none">
              Sign here
            </p>
          )}
        </div>

        <div className="flex gap-3 mt-3">
          <button
            onClick={handleClear}
            className="px-4 py-2.5 text-sm font-mono border border-ink-border rounded hover:bg-ink-surface transition-colors touch-target"
          >
            Clear
          </button>
          <button
            onClick={handleConfirm}
            disabled={!hasSignature}
            className="flex-1 py-2.5 bg-ink-green text-white text-sm font-mono font-medium rounded disabled:opacity-40 disabled:cursor-not-allowed hover:bg-ink-green-hover active:scale-[0.98] transition-all touch-target"
          >
            {status === "saving" ? "Saving…" : "Confirm & Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
