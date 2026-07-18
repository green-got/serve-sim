import type { ScreenshotToast as ScreenshotToastState } from "../hooks/use-screenshot-toast";
import { Download } from "lucide-react";

interface ScreenshotToastProps {
  toast: ScreenshotToastState;
  onDownload: () => void;
  onPause: () => void;
  onResume: () => void;
}

export function ScreenshotToast({
  toast,
  onDownload,
  onPause,
  onResume,
}: ScreenshotToastProps) {
  return (
    <div
      data-testid="screenshot-toast"
      className="w-[min(320px,calc(100vw-32px))]"
      onMouseEnter={onPause}
      onMouseLeave={onResume}
    >
      {toast.status === "error" ? (
        <div className="flex items-center gap-2 px-3.5 py-2.5 bg-panel border border-white/12 rounded-xl text-white/90 text-[12px] shadow-[0_8px_24px_rgba(0,0,0,0.45)]">
          <span className="size-1.5 rounded-full shrink-0 bg-[#f87171]" />
          <span className="select-text">{toast.message ?? "Screenshot failed"}</span>
        </div>
      ) : (
        <button
          type="button"
          onClick={onDownload}
          disabled={toast.status !== "saved"}
          aria-label="Download screenshot"
          title={toast.status === "saved" ? "Download screenshot again" : undefined}
          className="group flex w-full items-center gap-3 pl-2 pr-3.5 py-2 bg-panel border border-white/12 rounded-xl shadow-[0_8px_24px_rgba(0,0,0,0.45)] text-left cursor-pointer enabled:hover:bg-[#2a2a2c] disabled:cursor-default [transition:background_0.15s_ease]"
        >
          <div className="size-9 rounded-md overflow-hidden bg-white/10 shrink-0 flex items-center justify-center ring-1 ring-white/10 pointer-events-none">
            {toast.thumb ? (
              <img src={toast.thumb} alt="" className="size-full object-cover" draggable={false} />
            ) : (
              <span className="block size-4 rounded-full border-2 border-white/30 border-t-white animate-[grid-spin_0.8s_linear_infinite]" />
            )}
          </div>
          <div className="flex flex-col leading-tight pointer-events-none">
            <span className="text-[13px] font-semibold text-white">
              {toast.status === "saving" ? "Saving Screenshot…" : "Screenshot Downloaded"}
            </span>
            {toast.status === "saved" && (
              <span className="text-[11px] text-white/60">Download again</span>
            )}
          </div>
          {toast.status === "saved" && (
            <Download
              className="ml-auto text-white/80 pointer-events-none"
              size={16}
              strokeWidth={2.25}
            />
          )}
        </button>
      )}
    </div>
  );
}
