const CACHE = 'worktrack-v4';
const BASE  = '/punch-in';

const CORE_ASSETS = [
  BASE + '/',
  BASE + '/index.html',
  BASE + '/style.css',
  BASE + '/db.js',
  BASE + '/app.js',
  BASE + '/manifest.json'
];

const OPTIONAL_ASSETS = [
  BASE + '/icons/icon-192.png',
  BASE + '/icons/icon-512.png'
];

// ══ INSTALL ══
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(async cache => {
      await cache.addAll(CORE_ASSETS);
      await Promise.allSettled(
        OPTIONAL_ASSETS.map(url =>
          fetch(url).then(res => { if (res.ok) cache.put(url, res); }).catch(() => {})
        )
      );
    }).then(() => self.skipWaiting())
  );
});

// ══ ACTIVATE ══
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// ══ FETCH ══
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);

  // Navigation requests — always try network, fall back to cached index.html
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          if (res && res.status === 200)
            caches.open(CACHE).then(c => c.put(e.request, res.clone()));
          return res;
        })
        .catch(() =>
          caches.match(BASE + '/index.html').then(cached =>
            cached || new Response('<h2>WorkTrack offline</h2>', { headers: { 'Content-Type': 'text/html' } })
          )
        )
    );
    return;
  }

  // Asset requests — cache first, network fallback
  e.respondWith(
    caches.match(e.request).then(cached => {
      const net = fetch(e.request).then(res => {
        if (res && res.status === 200 && url.origin === self.location.origin)
          caches.open(CACHE).then(c => c.put(e.request, res.clone()));
        return res;
      }).catch(() => null);
      return cached || net;
    })
  );
});

// ══ MESSAGES ══
let watchdogTimer = null;

self.addEventListener('message', e => {
  const msg = e.data;
  if (!msg) return;

  if (msg.type === 'TIMER_RUNNING' || msg.type === 'HEARTBEAT') {
    clearTimeout(watchdogTimer);
    watchdogTimer = setTimeout(() => {
      showNotification('⏱ WorkTrack is still running', 'Your work timer is active. Unlock to check.', 'timer-running', false);
    }, 90000);
  }

  if (msg.type === 'TIMER_STOPPED') {
    clearTimeout(watchdogTimer);
    watchdogTimer = null;
    self.registration.getNotifications({ tag: 'timer-running' }).then(ns => ns.forEach(n => n.close()));
  }

  if (msg.type === 'GEO_EXIT') {
    clearTimeout(watchdogTimer);
    showNotification('🚨 Left work zone — timer paused', 'You moved outside your work zone. Return to resume.', 'geo-exit', true);
  }

  if (msg.type === 'GEO_ENTER') {
    self.registration.getNotifications({ tag: 'geo-exit' }).then(ns => ns.forEach(n => n.close()));
    showNotification('✅ Back in work zone', 'Timer has resumed.', 'geo-enter', false);
  }
});

function showNotification(title, body, tag, requireInteraction) {
  return self.registration.showNotification(title, {
    body, tag,
    renotify: true, silent: false,
    icon:    BASE + '/icons/icon-192.png',
    badge:   BASE + '/icons/icon-192.png',
    vibrate: [300, 150, 300, 150, 500],
    requireInteraction: !!requireInteraction,
    timestamp: Date.now(),
    actions: [{ action: 'open', title: '▶ Open App' }],
    data: { url: BASE + '/' }
  });
}

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || (BASE + '/');
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if (c.url.includes(self.location.origin) && 'focus' in c) return c.focus();
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
