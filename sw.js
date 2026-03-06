const CACHE = 'worktrack-light-v2';
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
// The app sends messages to the SW to schedule / cancel lock-screen alerts.
// Message types:
//   { type: 'TIMER_RUNNING', savedAt, pausedMs, sessionStart }  — start watchdog
//   { type: 'TIMER_STOPPED' }                                   — cancel watchdog
//   { type: 'GEO_EXIT' }                                        — immediate alert
//   { type: 'REQUEST_NOTIFICATION_PERMISSION' }                 — handled in app, not SW
let watchdogTimer = null;

self.addEventListener('message', e => {
  const msg = e.data;
  if (!msg) return;

  if (msg.type === 'TIMER_RUNNING') {
    // App is alive and timer is running — reset the watchdog.
    // If the app stops sending heartbeats (screen locked, killed) the watchdog
    // fires after 90 seconds and shows a "still tracking" reminder notification.
    clearTimeout(watchdogTimer);
    watchdogTimer = setTimeout(() => {
      showNotification(
        '⏱ WorkTrack is still running',
        'Your work timer is active. Unlock to check your status.',
        'timer-running'
      );
    }, 90000); // 90 seconds of silence = screen likely locked
  }

  if (msg.type === 'TIMER_STOPPED') {
    clearTimeout(watchdogTimer);
    watchdogTimer = null;
  }

  if (msg.type === 'GEO_EXIT') {
    // App detected zone exit and wants an immediate lock-screen notification
    clearTimeout(watchdogTimer);
    showNotification(
      '🚨 Left work zone — timer paused',
      'You moved outside your work zone. Open WorkTrack to resume.',
      'geo-exit'
    );
  }

  if (msg.type === 'GEO_ENTER') {
    showNotification(
      '✅ Back in work zone',
      'You returned to your work zone. Timer has resumed.',
      'geo-enter'
    );
  }

  if (msg.type === 'HEARTBEAT') {
    // Regular ping from app tick() — resets the watchdog so it only fires
    // when the app genuinely goes silent (screen lock / background kill)
    clearTimeout(watchdogTimer);
    watchdogTimer = setTimeout(() => {
      showNotification(
        '⏱ WorkTrack is still running',
        'Your work timer is active in the background.',
        'timer-running'
      );
    }, 90000);
  }
});

// ══ NOTIFICATION HELPER ══
function showNotification(title, body, tag) {
  self.registration.showNotification(title, {
    body,
    tag,                        // tag deduplicates — same tag replaces old notification
    renotify: true,             // vibrate even if replacing same tag
    icon:    '/icons/icon-192.png',
    badge:   '/icons/icon-192.png',
    vibrate: [300, 150, 300, 150, 500],  // strong vibration pattern
    requireInteraction: tag === 'geo-exit', // geo-exit stays until dismissed
    actions: [
      { action: 'open', title: '▶ Open App' }
    ],
    data: { url: '/' }
  });
}

// ══ NOTIFICATION CLICK ══
// Tapping the notification opens / focuses the app
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      // If app is already open in a tab, focus it
      for (const client of list) {
        if (client.url.includes(self.location.origin) && 'focus' in client)
          return client.focus();
      }
      // Otherwise open a new window
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
