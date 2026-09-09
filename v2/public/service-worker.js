const CACHE_NAME = "610ppt-v2-shell-v109-generation-feedback";
const APP_SHELL = [
  "/ai-settings.js?v=20260908-cover-reference-subtitle-v16",
  "/styles.css?v=20260908-cover-reference-subtitle-v16",
  "/app.js?v=20260909-generation-feedback-v12",
  "/copy-blueprint-editor.js?v=20260906-plain-copy-v1",
  "/export-preview-state.js?v=20260906-plain-copy-v1",
  "/project-history.js?v=20260906-plain-copy-v1",
  "/task-observer.js?v=20260906-plain-copy-v1",
  "/shared/task-lifecycle-contract.js?v=20260907-split-status-v1",
  "/shared/task-domain-reducer.js?v=20260906-plain-copy-v1",
  "/page-visibility.js?v=20260907-image-recovery-v1",
  "/batch-repair-state.js?v=20260907-qa-repair-v1",
  "/project-session.js",
  "/style-confirmation.js?v=20260828-style-running-v1",
  "/task-step.js?v=20260828-immediate-loading-v1",
  "/split-task-state.js",
  "/split-status.js?v=20260909-split-status-v2",
  "/content-review.js?v=20260906-plain-copy-v1",
  "/plain-copy.js?v=20260906-plain-copy-v1",
  "/style-reference-upload.js?v=20260907-ai-models-v1",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith("610ppt-v2-shell-") && key !== CACHE_NAME).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  // Let the browser navigate directly so the server receives a document request.
  // Precache/reconstructed fetches have an empty destination and cannot bootstrap
  // a local session. Never cache those responses as an offline homepage.
  if (request.mode === "navigate" || url.pathname === "/" || url.pathname === "/index.html") return;
  if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname === "/api" || url.pathname.startsWith("/api/")) return;
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok && !response.headers.get("Cache-Control")?.includes("no-store")) {
          const copy = response.clone();
          event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)));
        }
        return response;
      })
      .catch(() => caches.match(request))
  );
});
