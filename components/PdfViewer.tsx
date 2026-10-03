"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Render a PDF as canvases, one per page, fitted to the container's width.
 *
 * Exists because an <iframe> pointed at a PDF relies on the browser having a
 * built-in PDF viewer. Desktop browsers do; Chrome on Android does not, and
 * shows an empty frame — so a driver on a phone saw nothing where the invoice
 * or collection document should be. pdf.js draws the pages itself, which works
 * the same on every device.
 *
 * Loaded from the CDN on first use, the same build the Settings page uses for
 * its signature-position preview, so it is fetched at most once per session.
 * If it cannot load or the file cannot be parsed, the viewer says so and still
 * offers the file to open directly.
 */

const PDFJS_VERSION = "3.11.174";
const PDFJS_SRC = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}/pdf.min.js`;
const PDFJS_WORKER = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}/pdf.worker.min.js`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PdfJs = any;

let pdfjsPromise: Promise<PdfJs | null> | null = null;

function loadPdfJs(): Promise<PdfJs | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any;
  if (w.pdfjsLib) return Promise.resolve(w.pdfjsLib);
  if (!pdfjsPromise) {
    pdfjsPromise = new Promise((resolve) => {
      const script = document.createElement("script");
      script.src = PDFJS_SRC;
      script.onload = () => {
        const lib = w.pdfjsLib ?? null;
        if (lib) lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
        resolve(lib);
      };
      script.onerror = () => {
        // Let a later mount try again rather than caching the failure.
        pdfjsPromise = null;
        resolve(null);
      };
      document.head.appendChild(script);
    });
  }
  return pdfjsPromise;
}

interface PdfViewerProps {
  /** Same-origin URL of the PDF. Fetched with the session cookie. */
  src: string;
  title: string;
  className?: string;
}

export default function PdfViewer({ src, title, className = "" }: PdfViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [errorText, setErrorText] = useState("");

  useEffect(() => {
    let cancelled = false;
    const container = containerRef.current;
    if (!container) return;

    const render = async () => {
      setState("loading");
      container.replaceChildren();

      const pdfjs = await loadPdfJs();
      if (cancelled) return;
      if (!pdfjs) {
        setErrorText("The document viewer could not load.");
        setState("error");
        return;
      }

      try {
        // Fetched here rather than handed to pdf.js as a URL so a 404 reads as
        // "not found" instead of a parse error.
        const res = await fetch(src);
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `Could not load the document (${res.status})`);
        }
        const data = new Uint8Array(await res.arrayBuffer());
        if (cancelled) return;

        const pdf = await pdfjs.getDocument({ data }).promise;
        const width = container.clientWidth || 360;
        // Sharp on high-density phone screens, capped so a long document
        // doesn't exhaust a low-end device's memory.
        const ratio = Math.min(window.devicePixelRatio || 1, 2);

        for (let n = 1; n <= pdf.numPages; n++) {
          if (cancelled) return;
          const page = await pdf.getPage(n);
          const base = page.getViewport({ scale: 1 });
          const viewport = page.getViewport({ scale: (width / base.width) * ratio });

          const canvas = document.createElement("canvas");
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          canvas.style.width = "100%";
          canvas.style.display = "block";
          canvas.style.background = "#fff";
          if (n > 1) canvas.style.marginTop = "8px";
          canvas.setAttribute("aria-label", `${title}, page ${n} of ${pdf.numPages}`);
          container.appendChild(canvas);

          const ctx = canvas.getContext("2d");
          if (ctx) await page.render({ canvasContext: ctx, viewport }).promise;
        }
        if (!cancelled) setState("ready");
      } catch (err) {
        if (cancelled) return;
        setErrorText(err instanceof Error ? err.message : "Could not display the document.");
        setState("error");
      }
    };

    render();
    return () => {
      cancelled = true;
    };
  }, [src, title]);

  return (
    <div className={`relative overflow-y-auto bg-ink-surface ${className}`}>
      <div ref={containerRef} className="p-2" />
      {state === "loading" && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="w-6 h-6 border-2 border-ink-border border-t-ink-green rounded-full animate-spin" />
        </div>
      )}
      {state === "error" && (
        <div className="px-4 py-6 text-center">
          <p className="text-xs font-mono text-ink-muted mb-2">{errorText}</p>
        </div>
      )}
      {state !== "loading" && (
        <div className="px-2 pb-2 text-center">
          <a
            href={src}
            target="_blank"
            rel="noreferrer"
            className="text-[11px] font-mono text-ink-muted hover:text-ink-black underline"
          >
            Open PDF
          </a>
        </div>
      )}
    </div>
  );
}
