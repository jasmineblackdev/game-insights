/* GameLens — minimal service worker for notification clicks only (no caching). */
self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const raw = event.notification.data && event.notification.data.url;
  const url = typeof raw === "string" && raw.length > 0 ? raw : self.registration.scope;
  const targetOrigin = new URL(url).origin;

  event.waitUntil(
    (async () => {
      const clientList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const c of clientList) {
        try {
          if (new URL(c.url).origin === targetOrigin && "focus" in c) {
            await c.focus();
            if ("navigate" in c && typeof c.navigate === "function") {
              await c.navigate(url);
              return;
            }
          }
        } catch {
          /* ignore */
        }
      }
      if (self.clients.openWindow) await self.clients.openWindow(url);
    })()
  );
});
