// Preview-only worker: makes sure a stale production worker is never installed
// when the app is opened from a CDN subdirectory.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  self.registration.unregister();
  event.waitUntil(Promise.resolve());
});
