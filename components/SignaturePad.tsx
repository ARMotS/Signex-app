"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";

/**
 * The customer-signature canvas.
 *
 * Lifted verbatim out of the invoice sign page when collections needed the same
 * capture: the drawing behaviour is unchanged, down to the device-pixel-ratio
 * scaling and the passive:false touch listeners that stop a phone scrolling the
 * page while someone signs. Two copies of that would have drifted the first time
 * one of them was fixed.
 *
 * The canvas is uncontrolled — the parent asks for the PNG when it is ready,
 * rather than being re-rendered on every stroke.
 */
export interface SignaturePadHandle {
  /** The signature as a PNG data URL, or null if nothing has been drawn. */
  toDataURL: () => string | null;
  clear: () => void;
}

interface SignaturePadProps {
  /** Fires when the pad goes from empty to drawn, and back on clear. */
  onChange?: (hasSignature: boolean) => void;
  /** CSS height of the drawing area. */
  height?: number;
  label?: string;
  placeholder?: string;
}

const SignaturePad = forwardRef<SignaturePadHandle, SignaturePadProps>(
  function SignaturePad(
    { onChange, height = 120, label = "Customer Signature", placeholder = "Sign here" },
    ref
  ) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const [hasSignature, setHasSignature] = useState(false);

    const markDrawn = useCallback(() => {
      setHasSignature((prev) => {
        if (!prev) onChange?.(true);
        return true;
      });
    }, [onChange]);

    useEffect(() => {
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
        markDrawn();
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
    }, [markDrawn]);

    const clear = useCallback(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      setHasSignature(false);
      onChange?.(false);
    }, [onChange]);

    useImperativeHandle(
      ref,
      () => ({
        toDataURL: () =>
          hasSignature && canvasRef.current
            ? canvasRef.current.toDataURL("image/png")
            : null,
        clear,
      }),
      [hasSignature, clear]
    );

    return (
      <div>
        <div className="flex items-center justify-between mb-3">
          <p className="text-xs font-mono text-ink-muted uppercase tracking-wide">
            {label}
          </p>
          <button
            type="button"
            onClick={clear}
            disabled={!hasSignature}
            className="text-xs font-mono text-ink-muted hover:text-ink-black disabled:opacity-40 transition-colors"
          >
            Clear
          </button>
        </div>

        <div className="relative border-2 border-dashed border-ink-border rounded bg-ink-surface">
          {/* Baseline */}
          <div className="absolute bottom-8 left-4 right-4 border-b border-ink-border" />

          <canvas
            ref={canvasRef}
            className="w-full rounded cursor-crosshair"
            style={{ height: `${height}px`, touchAction: "none" }}
          />

          {!hasSignature && (
            <p className="absolute inset-0 flex items-center justify-center text-ink-muted text-sm font-mono pointer-events-none">
              {placeholder}
            </p>
          )}
        </div>
      </div>
    );
  }
);

export default SignaturePad;
