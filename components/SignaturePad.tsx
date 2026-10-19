"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { renderSignaturePng, strokeHasInk, type Stroke } from "@/lib/signature-strokes";

/**
 * The signature canvas — the customer's on an invoice or a collection, the
 * dispatcher's on a credit note.
 *
 * The strokes are kept as points, not only as pixels. Setting a canvas's size
 * erases it, and the size has to follow the layout: on Android the keyboard
 * opening or closing resizes the window, which is exactly what happens when
 * someone signs and then taps the name field above the pad (or the other way
 * round). The pad used to re-size on every window resize and lose the drawing
 * while still reporting "signed", so the PDF and the email went out with an
 * empty image. Now the canvas is only re-sized when its size really changed,
 * the strokes are redrawn after, and the PNG handed over is rendered from the
 * strokes themselves — it cannot come out blank once something was drawn.
 *
 * A tap draws a dot. Only ink counts as a signature, so a stray touch no longer
 * unlocks Confirm with nothing on the page.
 *
 * Pointer events cover mouse, finger and pen alike; the pointer is captured, so
 * a stroke that leaves the box still ends. touch-action: none stops a phone
 * scrolling the page while someone signs.
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

const INK = "#0F0F0F";
const LINE_WIDTH = 2.5;

const SignaturePad = forwardRef<SignaturePadHandle, SignaturePadProps>(
  function SignaturePad(
    { onChange, height = 120, label = "Customer Signature", placeholder = "Sign here" },
    ref
  ) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const strokesRef = useRef<Stroke[]>([]);
    const [hasSignature, setHasSignature] = useState(false);
    // Read by the listeners, which are attached once.
    const onChangeRef = useRef(onChange);
    const drawnRef = useRef(false);

    useEffect(() => {
      onChangeRef.current = onChange;
    }, [onChange]);

    const setDrawn = useCallback((drawn: boolean) => {
      if (drawnRef.current === drawn) return;
      drawnRef.current = drawn;
      setHasSignature(drawn);
      onChangeRef.current?.(drawn);
    }, []);

    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const style = () => {
        ctx.strokeStyle = INK;
        ctx.fillStyle = INK;
        ctx.lineWidth = LINE_WIDTH;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
      };

      const drawStroke = (s: Stroke) => {
        if (s.length === 1) {
          ctx.beginPath();
          ctx.arc(s[0].x, s[0].y, LINE_WIDTH / 2, 0, Math.PI * 2);
          ctx.fill();
          return;
        }
        ctx.beginPath();
        ctx.moveTo(s[0].x, s[0].y);
        for (let i = 1; i < s.length; i++) ctx.lineTo(s[i].x, s[i].y);
        ctx.stroke();
      };

      const redraw = () => {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        const dpr = window.devicePixelRatio || 1;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        style();
        for (const s of strokesRef.current) drawStroke(s);
      };

      // Only when the size really changed — assigning width/height erases the
      // canvas even when the value is the same.
      const fit = () => {
        const rect = canvas.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        const w = Math.round(rect.width * dpr);
        const h = Math.round(rect.height * dpr);
        if (w === 0 || h === 0) return;
        if (canvas.width !== w || canvas.height !== h) {
          canvas.width = w;
          canvas.height = h;
        }
        redraw();
      };

      fit();
      const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(fit) : null;
      observer?.observe(canvas);
      window.addEventListener("resize", fit);

      let current: Stroke | null = null;
      const pos = (e: PointerEvent) => {
        const rect = canvas.getBoundingClientRect();
        return { x: e.clientX - rect.left, y: e.clientY - rect.top };
      };

      const down = (e: PointerEvent) => {
        if (e.pointerType === "mouse" && e.button !== 0) return;
        e.preventDefault();
        canvas.setPointerCapture?.(e.pointerId);
        current = [pos(e)];
        strokesRef.current.push(current);
        drawStroke(current); // a tap is a dot
        setDrawn(true);
      };

      const move = (e: PointerEvent) => {
        if (!current) return;
        e.preventDefault();
        const last = current[current.length - 1];
        const next = pos(e);
        current.push(next);
        ctx.beginPath();
        ctx.moveTo(last.x, last.y);
        ctx.lineTo(next.x, next.y);
        ctx.stroke();
      };

      const up = (e: PointerEvent) => {
        if (!current) return;
        current = null;
        canvas.releasePointerCapture?.(e.pointerId);
      };

      canvas.addEventListener("pointerdown", down);
      canvas.addEventListener("pointermove", move);
      canvas.addEventListener("pointerup", up);
      canvas.addEventListener("pointercancel", up);

      return () => {
        observer?.disconnect();
        window.removeEventListener("resize", fit);
        canvas.removeEventListener("pointerdown", down);
        canvas.removeEventListener("pointermove", move);
        canvas.removeEventListener("pointerup", up);
        canvas.removeEventListener("pointercancel", up);
      };
    }, [setDrawn]);

    const clear = useCallback(() => {
      strokesRef.current = [];
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (canvas && ctx) {
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.restore();
      }
      setDrawn(false);
    }, [setDrawn]);

    useImperativeHandle(
      ref,
      () => ({
        toDataURL: () => {
          const canvas = canvasRef.current;
          if (!canvas || !strokeHasInk(strokesRef.current)) return null;
          return renderSignaturePng(strokesRef.current, { ink: INK, lineWidth: LINE_WIDTH });
        },
        clear,
      }),
      [clear]
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
          <div className="absolute bottom-8 left-4 right-4 border-b border-ink-border pointer-events-none" />

          <canvas
            ref={canvasRef}
            className="block w-full rounded cursor-crosshair"
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
