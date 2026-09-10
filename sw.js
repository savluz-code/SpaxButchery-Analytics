const CACHE_NAME = 'spax-v21';
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
// Cloud-sync POSTs (Apps Script) and every non-GET request bypass the cache
// entirely — the Cache API rejects POST outright, and a save must always hit
// the network even when the app was minimized mid-upload.
self.addEventListener('fetch', function(event) {
  if (event.request.method !== 'GET' || event.request.url.indexOf('script.google.com') !== -1) {
    event.respondWith(fetch(event.request));
    return;
  }
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

// Background Sync: the app registers 'spax-save' whenever a save is queued
// while hidden. On wake, tell every open client to resume; with no client
// open, notify the user instead of stalling silently.
self.addEventListener('sync', function(event) {
  if (event.tag === 'spax-save') {
    event.waitUntil(
      clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(list) {
        if (list && list.length) {
          list.forEach(function(c) {
            try { c.postMessage({ type: 'spax-resume-save' }); } catch (_) {}
          });
          return;
        }
        return self.registration.showNotification('SpaxButchery — save pending', {
          body: 'Open the app to finish syncing your changes to the cloud.',
          icon: 'icon-192.png',
          badge: 'icon-192.png',
          tag: 'spax-save-pending',
          requireInteraction: true
        });
      })
    );
  }
});
