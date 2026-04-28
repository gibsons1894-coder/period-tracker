const CACHE_NAME = 'period-tracker-v16';
const CACHE_URLS = [
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './icon_192.png',
  './icon_512.png'
];

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(CACHE_URLS).catch(() => {}))
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request).then(cached => cached || fetch(event.request))
  );
});

self.addEventListener('push', event => {
  const data = event.data ? event.data.json() : {};
  const title = data.title || '달력';
  const options = {
    body: data.body || '생리 예정일이 다가왔어요!',
    icon: './icon-192.png',
    badge: './icon-192.png',
    tag: 'period-reminder',
    renotify: true,
    vibrate: [200, 100, 200]
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window' }).then(clientList => {
      for (const client of clientList) {
        if (client.url.includes('index.html') && 'focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow('./index.html');
    })
  );
});

// 로컬 알림 스케줄 처리 (서버 없이 작동)
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SCHEDULE_NOTIFICATION') {
    const { title, body, delay } = event.data;
    setTimeout(() => {
      self.registration.showNotification(title, {
        body,
        icon: './icon-192.png',
        badge: './icon-192.png',
        tag: 'period-reminder',
        renotify: true,
        vibrate: [200, 100, 200]
      });
    }, delay);
  }
});
