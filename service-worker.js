const CACHE_NAME = 'extractor-shell-v1';
const SHELL_FILES = ['/', '/manifest.json', '/icon.svg'];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(names =>
      Promise.all(names.filter(n => n !== CACHE_NAME).map(n => caches.delete(n)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  const isShell = SHELL_FILES.includes(url.pathname);

  if (isShell) {
    // shell: responde desde cache, sin bloquear la actualización en segundo plano
    event.respondWith(
      caches.match(event.request).then(cached => cached || fetch(event.request))
    );
  }
  // todo lo demás (incluido /api/extract) siempre va directo a la red
});
