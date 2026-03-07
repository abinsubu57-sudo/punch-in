const CACHE = 'worktrack-light-v3';
const ASSETS = ['/', '/index.html', '/style.css', '/db.js', '/app.js', '/manifest.json', '/icons/icon-192.png', '/icons/icon-512.png'];

// ══ INSTALL ══
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

// ══ ACTIVATE ══
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// ══ FETCH (cache-first with network fallback) ══
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then(cached => {
      const net = fetch(e.request).then(res => {
        if (res && res.status === 200)
          caches.open(CACHE).then(c => c.put(e.request, res.clone()));
        return res;
      }).catch(() => cached);
      return cached || net;
    })
  );
});

// ══ MESSAGES FROM APP ══
let watchdogTimer = null;

self.addEventListener('message', e => {
  const msg = e.data;
  if (!msg) return;

  if (msg.type === 'TIMER_RUNNING' || msg.type === 'HEARTBEAT') {
    // Reset 90-second watchdog
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
    // Dismiss any existing timer notification
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
      true  // requireInteraction: stays until dismissed
    );
  }

  if (msg.type === 'GEO_ENTER') {
    // Dismiss the geo-exit notification
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
// Android notes:
// - 'silent: false' ensures vibration even when replacing same tag
// - 'renotify: true' is required to vibrate again on same tag
// - 'requireInteraction' keeps geo-exit visible until user acts
// - icon must be png and served from same origin
function showNotification(title, body, tag, requireInteraction) {
  const options = {
    body,
    tag,
    renotify:            true,
    silent:              false,
    icon:                '/icons/icon-192.png',
    badge:               '/icons/icon-192.png',
    vibrate:             [300, 150, 300, 150, 500],
    requireInteraction:  !!requireInteraction,
    timestamp:           Date.now(),
    actions: [
      { action: 'open', title: '▶ Open App' }
    ],
    data: { url: '/' }
  };

  // showNotification returns a promise — wait for it so the SW doesn't die early
  return self.registration.showNotification(title, options);
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

// ══ NOTIFICATION CLOSE ══
// User explicitly dismissed — no action needed
self.addEventListener('notificationclose', e => {
  // Optionally log dismissal
});
