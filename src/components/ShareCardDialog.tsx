import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { useFocusTrap } from "../lib/useFocusTrap";
import { useToast } from "./Toast";
import {
  CARD_W,
  CARD_H,
  SCALE,
  drawCard,
  sanitizeQuoteForCard,
  defaultStyleForMode,
  type CardStyle,
} from "../lib/quoteCard";

interface ShareCardDialogProps {
  quote: string;
  title: string;
  author: string;
  coverPath: string | null;
  initialMode: string;
  onClose: () => void;
}

const STYLES: CardStyle[] = ["light", "sepia", "dark"];

// Strips characters that are illegal (or awkward) in filenames across
// Windows/macOS/Linux, collapsing whitespace along the way.
function sanitizeFilename(raw: string): string {
  const cleaned = raw
    .replace(/[/\\?%*:|"<>]/g, "")
    .trim()
    .replace(/\s+/g, " ");
  return cleaned.length > 0 ? cleaned : "quote";
}

/**
 * Modal for rendering a highlight/selection as a shareable "quote card" PNG
 * (F-1-6). Live canvas preview + style/cover/wordmark controls + Copy image
 * and Save PNG….
 */
export default function ShareCardDialog({ quote, title, author, coverPath, initialMode, onClose }: ShareCardDialogProps) {
  const { t } = useTranslation();
  const { addToast } = useToast();
  const dialogRef = useFocusTrap(onClose);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const sanitizedQuote = useMemo(() => sanitizeQuoteForCard(quote), [quote]);

  const [style, setStyle] = useState<CardStyle>(() => defaultStyleForMode(initialMode));
  const [coverImg, setCoverImg] = useState<HTMLImageElement | null>(null);
  const [includeCover, setIncludeCover] = useState(false);
  const [includeWordmark, setIncludeWordmark] = useState(false);
  const [fontsReady, setFontsReady] = useState(false);
  const [copying, setCopying] = useState(false);
  const [saving, setSaving] = useState(false);

  // Load the cover once, if any. On failure, disable the cover toggle rather
  // than blocking the rest of the card.
  useEffect(() => {
    if (!coverPath) {
      setCoverImg(null);
      return;
    }
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (cancelled) return;
      setCoverImg(img);
      setIncludeCover(true);
    };
    img.onerror = () => {
      if (cancelled) return;
      setCoverImg(null);
      addToast(t("shareCard.toasts.coverLoadFailed"), "error");
    };
    // Anonymous CORS mode keeps the canvas origin-clean when we later draw
    // this image — Tauri's asset protocol serves permissive CORS headers,
    // so this succeeds. Without it, getImageData() in handleCopyImage
    // throws SecurityError (canvas taint).
    img.crossOrigin = "anonymous";
    img.src = convertFileSrc(coverPath);
    return () => {
      cancelled = true;
    };
    // addToast/t are stable enough in practice; re-running on coverPath change is what matters here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coverPath]);

  // Canvas text metrics need the real font loaded, or the first draw
  // mis-measures with a fallback face.
  useEffect(() => {
    let cancelled = false;
    document.fonts.ready.then(() => {
      if (!cancelled) setFontsReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Live preview: redraw on any control change. The canvas backing store
  // stays at CARD_W*SCALE x CARD_H*SCALE; CSS sizes it down for display.
  useEffect(() => {
    if (!fontsReady) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = CARD_W * SCALE;
    canvas.height = CARD_H * SCALE;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(SCALE, SCALE);
    drawCard(
      ctx,
      {
        quote: sanitizedQuote,
        title,
        author,
        style,
        includeCover: includeCover && coverImg !== null,
        includeWordmark,
      },
      coverImg,
    );
  }, [fontsReady, sanitizedQuote, title, author, style, includeCover, includeWordmark, coverImg]);

  const handleCopyImage = useCallback(async () => {
    const canvas = canvasRef.current;
    if (!canvas || copying) return;
    setCopying(true);
    try {
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("2d context unavailable");
      const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      // writeImage's raw-buffer overloads expect *decoded* RGBA bytes, not
      // encoded PNG — passing PNG bytes through Uint8Array/number[] hits
      // tauri's JsImage::Bytes path, which needs the image-png Cargo feature
      // we don't enable. Image.new() takes raw RGBA directly (as our canvas
      // already has via getImageData) with no such feature requirement.
      const { Image } = await import("@tauri-apps/api/image");
      const { writeImage } = await import("@tauri-apps/plugin-clipboard-manager");
      let image: Awaited<ReturnType<typeof Image.new>> | null = null;
      try {
        image = await Image.new(new Uint8Array(data), width, height);
        await writeImage(image);
        addToast(t("shareCard.toasts.copied"), "success");
      } finally {
        // Image.new() allocates a backend-side resource (~23MB for a card
        // this size) that isn't freed by GC — close it explicitly or repeated
        // Copy image presses leak memory. A close() failure shouldn't mask
        // whatever copy outcome was already toasted above.
        try {
          await image?.close();
        } catch {
          // ignore — best-effort cleanup
        }
      }
    } catch {
      addToast(t("shareCard.toasts.copyFailed"), "error");
    } finally {
      setCopying(false);
    }
  }, [copying, addToast, t]);

  const handleSavePng = useCallback(async () => {
    const canvas = canvasRef.current;
    if (!canvas || saving) return;
    try {
      const safeName = sanitizeFilename(title);
      const path = await save({
        defaultPath: `${safeName} — highlight.png`,
        filters: [{ name: "PNG", extensions: ["png"] }],
      });
      if (!path) return;
      setSaving(true);
      canvas.toBlob(async (blob) => {
        try {
          if (!blob) {
            addToast(t("shareCard.toasts.saveFailed"), "error");
            return;
          }
          const buf = await blob.arrayBuffer();
          await invoke("save_quote_card_png", { path, bytes: Array.from(new Uint8Array(buf)) });
          addToast(t("shareCard.toasts.saved"), "success");
        } catch {
          addToast(t("shareCard.toasts.saveFailed"), "error");
        } finally {
          setSaving(false);
        }
      }, "image/png");
    } catch {
      addToast(t("shareCard.toasts.saveFailed"), "error");
      setSaving(false);
    }
  }, [saving, title, addToast, t]);

  return (
    <>
      <div className="fixed inset-0 bg-ink/40 backdrop-blur-sm z-[90] animate-fade-in" onClick={onClose} />
      <div className="fixed inset-0 z-[90] flex items-center justify-center p-4 pointer-events-none">
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-label={t("shareCard.title")}
          className="bg-surface rounded-2xl shadow-xl border border-warm-border w-full max-w-md pointer-events-auto animate-slide-in-up overflow-hidden max-h-[90vh] flex flex-col"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-5 py-4 border-b border-warm-border flex items-center justify-between shrink-0">
            <h2 className="font-serif text-base font-semibold text-ink">{t("shareCard.title")}</h2>
            <button
              onClick={onClose}
              className="p-1 text-ink-muted hover:text-ink transition-colors rounded"
              aria-label={t("common.close")}
            >
              <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
                <path d="M15 5L5 15M5 5l10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </button>
          </div>

          <div className="px-5 py-4 space-y-4 overflow-y-auto">
            <div className="flex justify-center">
              <canvas
                ref={canvasRef}
                style={{ width: 260, height: (260 * CARD_H) / CARD_W, borderRadius: 12 }}
                className="shadow-md border border-warm-border"
              />
            </div>

            <div className="flex gap-1 bg-warm-subtle rounded-xl p-1">
              {STYLES.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setStyle(s)}
                  className={`flex-1 px-3 py-1.5 text-sm rounded-lg transition-all duration-150 ${
                    style === s ? "bg-surface text-ink shadow-sm font-medium" : "text-ink-muted hover:text-ink"
                  }`}
                >
                  {t(`shareCard.styles.${s}`)}
                </button>
              ))}
            </div>

            <div className="space-y-2">
              <label className={`flex items-center justify-between gap-3 ${coverImg === null ? "opacity-40 pointer-events-none" : ""}`}>
                <span className="text-sm text-ink">{t("shareCard.includeCover")}</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={includeCover}
                  disabled={coverImg === null}
                  onClick={() => setIncludeCover((v) => !v)}
                  className={`relative w-10 h-6 rounded-full transition-colors ${includeCover ? "bg-accent" : "bg-warm-border"}`}
                >
                  <span
                    className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${includeCover ? "translate-x-4" : ""}`}
                  />
                </button>
              </label>

              <label className="flex items-center justify-between gap-3">
                <span className="text-sm text-ink">{t("shareCard.includeWordmark")}</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={includeWordmark}
                  onClick={() => setIncludeWordmark((v) => !v)}
                  className={`relative w-10 h-6 rounded-full transition-colors ${includeWordmark ? "bg-accent" : "bg-warm-border"}`}
                >
                  <span
                    className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${includeWordmark ? "translate-x-4" : ""}`}
                  />
                </button>
              </label>
            </div>
          </div>

          <div className="px-5 py-4 border-t border-warm-border flex gap-2 justify-end shrink-0">
            <button
              onClick={onClose}
              className="px-4 py-1.5 text-sm font-medium text-ink-muted hover:text-ink hover:bg-warm-subtle rounded-lg transition-colors duration-150"
            >
              {t("common.close")}
            </button>
            <button
              onClick={handleSavePng}
              disabled={saving || !fontsReady}
              className="px-4 py-1.5 text-sm font-medium text-ink bg-warm-subtle rounded-lg hover:bg-warm-border transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {t("shareCard.savePng")}
            </button>
            <button
              onClick={handleCopyImage}
              disabled={copying || !fontsReady}
              className="px-4 py-1.5 text-sm font-medium bg-accent text-white rounded-lg hover:bg-accent-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {t("shareCard.copyImage")}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
