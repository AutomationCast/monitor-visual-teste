const release = '0.4.0';
const prefix = 'monitor-visual-shell:' + self.registration.scope + ':';
const cacheName = prefix + release;
const appFiles = [
  './index.html', './styles.css', './app.js', './manifest.webmanifest',
  './level.mjs', './remote.mjs', './alerta.html', './alerta.mjs', './icon-192.png', './icon-512.png'
].map((file) => new URL(file, self.registration.scope).href);
const entryPage = appFiles[0];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(cacheName).then((cache) =>
    cache.addAll(appFiles.map((file) => new Request(file, { cache: 'reload' })))));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name.startsWith(prefix) && name !== cacheName)
      .map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  const root = new URL(self.registration.scope);
  const navigation = request.mode === 'navigate'
    && url.origin === root.origin
    && (url.pathname === root.pathname || url.pathname === new URL(entryPage).pathname);
  const cachedUrl = navigation ? entryPage : request.url;
  if (!appFiles.includes(cachedUrl)) return;

  event.respondWith((async () => {
    const cache = await caches.open(cacheName);
    return (await cache.match(cachedUrl)) ?? fetch(request);
  })());
});
