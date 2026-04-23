import type { LiveEdgeNotificationPayload } from "@/lib/liveEdgeNotificationEngine";

export async function registerGameLensNotifyServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) return null;
  try {
    return await navigator.serviceWorker.register("/sw-gamelens-notify.js", { scope: "/" });
  } catch {
    return null;
  }
}

export async function deliverLiveEdgeNotification(payload: LiveEdgeNotificationPayload): Promise<void> {
  const absUrl = `${typeof window !== "undefined" ? window.location.origin : ""}${payload.url}`;

  const reg =
    typeof navigator !== "undefined" && "serviceWorker" in navigator
      ? await navigator.serviceWorker.getRegistration()
      : undefined;

  if (reg) {
    await reg.showNotification(payload.title, {
      body: payload.body,
      icon: "/GameLens_logo.png",
      badge: "/favicon.png",
      tag: payload.tag,
      data: { url: absUrl },
      // renotify requires tag; cast because TS lib may not include it yet
      ...({ renotify: true } as Record<string, unknown>),
    });
    return;
  }

  if (typeof Notification === "undefined") return;

  const n = new Notification(payload.title, {
    body: payload.body,
    icon: "/GameLens_logo.png",
    tag: payload.tag,
  });
  n.onclick = () => {
    window.focus();
    window.location.href = absUrl;
    n.close();
  };
}
