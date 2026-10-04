/**
 * Döngüm - Çevrimdışı Çalışma & PWA Hizmet Yöneticisi (Service Worker)
 * Sunucu kapalıyken veya internet bağlantısı yokken uygulamanın
 * telefonun hafızasından %100 kesintisiz açılmasını sağlar.
 */

const CACHE_NAME = 'dongum-pwa-v25';

const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './assets/logo.svg',
  './assets/logo.png',
  './assets/logo-192.png'
];

// 1. Kurulum (Install): Statik kaynakları telefon önbelleğine al
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      // Temel çekirdek dosyaları önbelleğe al
      try {
        await cache.addAll(['./', './index.html', './manifest.webmanifest']);
      } catch (err) {
        console.warn('Temel çekirdek önbelleğe alınırken uyarı:', err);
      }
      // İsteğe bağlı simgeler (klasör GitHub'da yoksa bile kurulum başarısız olmasın)
      const optionalAssets = [
        './apple-touch-icon.png',
        './favicon.ico',
        './assets/logo.svg',
        './assets/logo.png',
        './assets/logo-192.png'
      ];
      for (const asset of optionalAssets) {
        try {
          await cache.add(asset);
        } catch (e) {
          // İsteğe bağlı dosya yoksa atla
        }
      }
    }).then(() => {
      return self.skipWaiting();
    })
  );
});

// 2. Etkinleştirme (Activate): Eski önbellekleri temizle ve kontrolü hemen devral
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => {
      return self.clients.claim();
    })
  );
});

// 3. İstek Yakalama (Fetch): Önbellek Öncelikli (Cache-First) + Çevrimdışı Gezinti Garantisi
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      // 1. Kaynak telefonda kayıtlıysa doğrudan sunucusuz aç (0 ms bekleme)
      if (cachedResponse) {
        // Arka planda sunucu açıksa önbelleği sessizce güncelle
        fetch(event.request).then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, networkResponse);
            });
          }
        }).catch(() => {
          // Çevrimdışı / sunucu kapalı
        });

        return cachedResponse;
      }

      // 2. Kaynak henüz önbellekte yoksa ağdan çekmeyi dene
      return fetch(event.request).then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200) {
          const responseClone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseClone);
          });
        }
        return networkResponse;
      }).catch(async () => {
        // 3. Sunucu kapalı veya internet yok: Sayfa gezintilerinde index.html'e dön
        if (event.request.mode === 'navigate') {
          const fallback = await caches.match('./index.html');
          if (fallback) return fallback;
          return await caches.match('./');
        }
      });
    })
  );
});

// 4. Bildirime Tıklama (Notification Click): Uygulamayı öne getir veya aç
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const targetUrl = './index.html';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // Zaten açık bir sekme/pencere varsa onu odakla
      for (const client of clientList) {
        if ('focus' in client) {
          if (event.notification.data && event.notification.data.tab) {
            client.postMessage({ type: 'NAVIGATE_TAB', tab: event.notification.data.tab });
          }
          return client.focus();
        }
      }
      // Açık sekme yoksa yeni pencere aç
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});

// 5. Arka Plan Push Desteği (İleride Harici Sunucu / Web Push için Hazır)
self.addEventListener('push', (event) => {
  let data = {};
  if (event.data) {
    try {
      data = event.data.json();
    } catch (e) {
      data = { title: 'Döngüm', body: event.data.text() };
    }
  }
  const title = data.title || '🌸 Döngüm Hatırlatması';
  const options = {
    body: data.body || 'Döngünüzle ilgili yeni bir hatırlatmanız var.',
    icon: './apple-touch-icon.png',
    badge: './assets/logo-192.png',
    vibrate: [100, 50, 100],
    data: data.data || { url: './index.html' }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});
