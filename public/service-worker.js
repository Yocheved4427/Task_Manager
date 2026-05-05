/* ================================================================
   Task Manager – Service Worker
   Caches static assets for offline use and handles notification
   click events.
   ================================================================ */

const CACHE_NAME    = 'task-manager-v6';
const STATIC_ASSETS = [
  '/manifest.json',
  '/css/styles.css?v=2',
  '/js/api.js',
  '/js/app.js?v=2',
  '/icons/icon.svg'
];

// ── Install: pre-cache shell ──────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

// ── Activate: remove old caches ──────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ── Fetch: network-first for API, cache-first for assets ─────────
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Always go to network for HTML so the entry point is always fresh
  if (url.pathname === '/' || url.pathname.endsWith('.html')) {
    event.respondWith(fetch(event.request));
    return;
  }

  // Always go to network for API and image uploads
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/uploads/')) {
    event.respondWith(
      fetch(event.request).catch(() =>
        new Response(JSON.stringify({ error: 'Offline' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' }
        })
      )
    );
    return;
  }

  // Cache-first for everything else
  event.respondWith(
    caches.match(event.request).then(cached => cached || fetch(event.request))
  );
});

// ── Notification click: handle actions or open/focus the app ────────
self.addEventListener('notificationclick', event => {
  const taskId = event.notification.data && event.notification.data.taskId;
  const action = event.action;
  event.notification.close();

  // ✓ Done — mark task complete via API, then refresh the open page
  if (action === 'done' && taskId) {
    event.waitUntil(
      fetch(`/api/tasks/${encodeURIComponent(taskId)}/done`, { method: 'PATCH' })
        .then(() =>
          clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
            list.forEach(c => c.postMessage({ type: 'refreshTasks' }));
          })
        )
        .catch(() => {})
    );
    return;
  }

  // ⏰ Try Later — ask the open page to snooze for 30 minutes
  if (action === 'try-later' && taskId) {
    event.waitUntil(
      clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
        const existing = list.find(c => c.url.includes(self.location.origin));
        if (existing) {
          existing.postMessage({ type: 'snoozeTask', taskId });
        }
        // If no page is open the snooze is silently dropped (SW can't reliably setTimeout)
      })
    );
    return;
  }

  // Default click: open/focus the app and navigate to the task
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      const existing = list.find(c => c.url.includes(self.location.origin));
      if (existing) {
        return existing.focus().then(client => {
          if (taskId) client.postMessage({ type: 'openTask', taskId });
        });
      }
      // Page is closed — open it, then send the task ID once it's ready
      return clients.openWindow('/').then(client => {
        if (client && taskId) {
          setTimeout(() => client.postMessage({ type: 'openTask', taskId }), 1500);
        }
      });
    })
  );
});
