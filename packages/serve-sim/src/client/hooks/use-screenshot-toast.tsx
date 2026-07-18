import { useCallback, useEffect, useRef } from "react";
import { toast as sonnerToast } from "sonner";
import { ScreenshotToast } from "../components/screenshot-toast";
import { simEndpoint } from "../utils/sim-endpoint";

export type ScreenshotToast = {
  id: string;
  status: "saving" | "saved" | "error";
  phase: "in" | "out";
  downloadUrl?: string;
  filename?: string;
  thumb?: string;
  message?: string;
};

const SAVED_DISMISS_MS = 3500;
const ERROR_DISMISS_MS = 4000;

function timestampSlug(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 23);
}

export function filenameFromContentDisposition(value: string | null): string | null {
  if (!value) return null;
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(value)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded).split(/[\\/]/).pop() || null;
    } catch {}
  }
  const quoted = /filename="([^"]+)"/i.exec(value)?.[1];
  const plain = quoted ?? /filename=([^;]+)/i.exec(value)?.[1]?.trim();
  return plain?.split(/[\\/]/).pop() || null;
}

export function triggerBrowserDownload(url: string, filename: string): void {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}

export function useScreenshotToast(deviceUdid?: string | null) {
  const toastRef = useRef<ScreenshotToast | null>(null);
  const toastIdRef = useRef<string | null>(null);
  const downloadUrlRef = useRef<string | null>(null);
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dismissDeadlineRef = useRef<number | null>(null);
  const remainingDismissMsRef = useRef<number | null>(null);

  const clearDownloadUrl = useCallback(() => {
    if (downloadUrlRef.current) URL.revokeObjectURL(downloadUrlRef.current);
    downloadUrlRef.current = null;
  }, []);

  const clearDismissTimer = useCallback(() => {
    if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
    dismissTimerRef.current = null;
    dismissDeadlineRef.current = null;
  }, []);

  const dismiss = useCallback((id?: string | number) => {
    const targetId = id ?? toastIdRef.current ?? undefined;
    clearDismissTimer();
    remainingDismissMsRef.current = null;
    sonnerToast.dismiss(targetId);
    if (targetId === undefined || toastIdRef.current === String(targetId)) {
      toastRef.current = null;
      toastIdRef.current = null;
      clearDownloadUrl();
    }
  }, [clearDismissTimer, clearDownloadUrl]);

  useEffect(() => () => {
    clearDismissTimer();
    clearDownloadUrl();
  }, [clearDismissTimer, clearDownloadUrl]);

  const download = useCallback(() => {
    const toast = toastRef.current;
    if (toast?.downloadUrl && toast.filename) {
      triggerBrowserDownload(toast.downloadUrl, toast.filename);
    }
  }, []);

  const scheduleDismiss = useCallback((ms: number) => {
    clearDismissTimer();
    const delay = Math.max(0, ms);
    const id = toastIdRef.current;
    remainingDismissMsRef.current = delay;
    dismissDeadlineRef.current = Date.now() + delay;
    dismissTimerRef.current = setTimeout(() => dismiss(id ?? undefined), delay);
  }, [clearDismissTimer, dismiss]);

  const pauseDismiss = useCallback(() => {
    if (!dismissTimerRef.current || dismissDeadlineRef.current == null) return;
    remainingDismissMsRef.current = Math.max(0, dismissDeadlineRef.current - Date.now());
    clearDismissTimer();
  }, [clearDismissTimer]);

  const resumeDismiss = useCallback(() => {
    const remaining = remainingDismissMsRef.current;
    if (remaining == null) return;
    scheduleDismiss(remaining);
  }, [scheduleDismiss]);

  const render = useCallback((next: ScreenshotToast, duration = Infinity) => {
    toastRef.current = next;
    toastIdRef.current = next.id;
    sonnerToast.custom(
      () => (
        <ScreenshotToast
          toast={next}
          onDownload={download}
          onPause={pauseDismiss}
          onResume={resumeDismiss}
        />
      ),
      { id: next.id, duration: Infinity },
    );
    if (Number.isFinite(duration)) scheduleDismiss(duration);
    else {
      clearDismissTimer();
      remainingDismissMsRef.current = null;
    }
  }, [clearDismissTimer, download, pauseDismiss, resumeDismiss, scheduleDismiss]);

  const capture = useCallback(async () => {
    if (!deviceUdid) return;
    const id = crypto.randomUUID();
    clearDownloadUrl();
    render({ id, status: "saving", phase: "in" });

    const configuredEndpoint = window.__SIM_PREVIEW__?.screenshotEndpoint;
    const endpoint = configuredEndpoint
      ?? `${simEndpoint("api/screenshot")}?device=${encodeURIComponent(deviceUdid)}`;
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${window.__SIM_PREVIEW__?.execToken ?? ""}`,
          "Content-Type": "application/json",
        },
        body: "{}",
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(body?.error || `Screenshot failed (${response.status})`);
      }
      const blob = await response.blob();
      if (blob.size === 0) throw new Error("Simulator returned an empty screenshot");
      const filename = filenameFromContentDisposition(response.headers.get("content-disposition"))
        ?? `serve-sim-screenshot-${timestampSlug()}.png`;
      const downloadUrl = URL.createObjectURL(blob);
      downloadUrlRef.current = downloadUrl;
      const saved = { id, status: "saved", phase: "in", downloadUrl, filename, thumb: downloadUrl } as const;
      render(saved, SAVED_DISMISS_MS);
      triggerBrowserDownload(downloadUrl, filename);
    } catch (error) {
      render({
        id,
        status: "error",
        phase: "in",
        message: error instanceof Error ? error.message : "Screenshot failed",
      }, ERROR_DISMISS_MS);
    }
  }, [clearDownloadUrl, deviceUdid, render]);

  return { capture, download, dismiss };
}
