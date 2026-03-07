const CACHE = 'worktrack-v4';

// Core assets that MUST be cached for offline use.
// Icons are optional — if they 404 on install it shouldn't break the PWA.
const CORE_ASSETS = [
  '/index.html',
  '/style.css',
  '/db.js',
  '/app.js',
  '/manifest.json'
];

const OPTIONAL_ASSETS = [
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

// ══ INSTALL — cache core assets, try optional ones too ══
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(async cache => {
      // Core assets must succeed
      await cache.addAll(CORE_ASSETS);
      // Optional assets: try each individually, ignore failures
      await Promise.allSettled(
        OPTIONAL_ASSETS.map(url =>
          fetch(url).then(res => {
            if (res.ok) cache.put(url, res);
          }).catch(() => {})
        )
      );
    }).then(() => self.skipWaiting())
  );
});

// ══ ACTIVATE — delete old caches ══
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ══ FETCH — navigation requests always get index.html ══
// This is the critical fix for the PWA 404:
// When the app launches from the home screen, the browser navigates to "/"
// (or whatever start_url is). Without this handler, if "/" isn't cached
// exactly, the SW returns a 404 instead of serving index.html.
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;

  const url = new URL(e.request.url);

  // ── Navigation requests (page loads / PWA launch) ──
  // Always try network first, fall back to cached index.html.
  // This handles: /, /index.html, and any deep-link paths.
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          if (res && res.status === 200) {
            caches.open(CACHE).then(c => c.put(e.request, res.clone()));
          }
          return res;
        })
        .catch(() => {
          // Network failed (offline) — serve cached index.html
          return caches.match('/index.html').then(cached => {
            return cached || new Response(
              '<h2>WorkTrack is offline</h2><p>Please check your connection.</p>',
              { headers: { 'Content-Type': 'text/html' } }
            );
          });
        })
    );
    return;
  }

  // ── Asset requests (JS, CSS, images, fonts) ──
  // Cache-first: serve from cache instantly, update in background
  e.respondWith(
    caches.match(e.request).then(cached => {
      const networkFetch = fetch(e.request).then(res => {
        if (res && res.status === 200 && url.origin === self.location.origin) {
          caches.open(CACHE).then(c => c.put(e.request, res.clone()));
        }
        return res;
      }).catch(() => null);

      return cached || networkFetch;
    })
  );
});

// ══ MESSAGES FROM APP ══
let watchdogTimer = null;

self.addEventListener('message', e => {
  const msg = e.data;
  if (!msg) return;

  if (msg.type === 'TIMER_RUNNING' || msg.type === 'HEARTBEAT') {
    clearTimeout(watchdogTimer);
    watchdogTimer = setTimeout(() => {
      showNotification(
        '⏱ WorkTrack is still running',
        'Your work timer is active. Unlock to check your status.',
        'timer-running',
        false
      );
    }, 90000);
  }

  if (msg.type === 'TIMER_STOPPED') {
    clearTimeout(watchdogTimer);
    watchdogTimer = null;
    self.registration.getNotifications({ tag: 'timer-running' }).then(notifs => {
      notifs.forEach(n => n.close());
    });
  }

  if (msg.type === 'GEO_EXIT') {
    clearTimeout(watchdogTimer);
    showNotification(
      '🚨 Left work zone — timer paused',
      'You moved outside your work zone. Return to resume tracking.',
      'geo-exit',
      true
    );
  }

  if (msg.type === 'GEO_ENTER') {
    self.registration.getNotifications({ tag: 'geo-exit' }).then(notifs => {
      notifs.forEach(n => n.close());
    });
    showNotification(
      '✅ Back in work zone',
      'You returned to your work zone. Timer has resumed.',
      'geo-enter',
      false
    );
  }
});

// ══ NOTIFICATION HELPER ══
function showNotification(title, body, tag, requireInteraction) {
  return self.registration.showNotification(title, {
    body,
    tag,
    renotify:           true,
    silent:             false,
    icon:               '/icons/icon-192.png',
    badge:              '/icons/icon-192.png',
    vibrate:            [300, 150, 300, 150, 500],
    requireInteraction: !!requireInteraction,
    timestamp:          Date.now(),
    actions: [{ action: 'open', title: '▶ Open App' }],
    data: { url: '/' }
  });
}

// ══ NOTIFICATION CLICK ══
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if (client.url.includes(self.location.origin) && 'focus' in client)
          return client.focus();
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
