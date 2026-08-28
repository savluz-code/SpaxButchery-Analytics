const CACHE_NAME = 'spax-v7';
const urlsToCache = [
  '/SpaxButchery-Analytics/',
  '/SpaxButchery-Analytics/index.html'
];

// Install: cache core assets
self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return cache.addAll(urlsToCache);
    })
  );
  self.skipWaiting();
});

// Activate: clean old caches
self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(cacheNames) {
      return Promise.all(
        cacheNames.filter(function(name) {
          return name !== CACHE_NAME;
        }).map(function(name) {
          return caches.delete(name);
        })
      );
    })
  );
  self.clients.claim();
});

// Fetch: network-first for navigations so installed apps receive updates.
self.addEventListener('fetch', function(event) {
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(function() {
        // Offline fallback: return the cached app shell.
        return caches.match('/SpaxButchery-Analytics/');
      })
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then(function(response) {
      if (response) {
        return response;
      }
      return fetch(event.request);
    })
  );
});

// Push notification handler
self.addEventListener('push', function(event) {
  const data = event.data ? event.data.json() : {};
  const title = data.title || 'SpaxButchery';
  const options = {
    body: data.body || 'New customer activity',
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    tag: data.tag || 'spax-default',
    requireInteraction: true,
    data: data
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// Notification click handler
self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  event.waitUntil(
    clients.openWindow('/SpaxButchery-Analytics/')
  );
});
