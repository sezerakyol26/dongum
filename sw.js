/**
 * Döngüm - Çevrimdışı Çalışma & PWA Hizmet Yöneticisi (Service Worker)
 * Sunucu kapalıyken veya internet bağlantısı yokken uygulamanın
 * telefonun hafızasından %100 kesintisiz açılmasını sağlar.
 */

const CACHE_NAME = 'dongum-pwa-v11';

const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './assets/logo.svg'
];

// 1. Kurulum (Install): Tüm statik kaynakları telefon önbelleğine al
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE);
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
      }).catch(() => {
        // 3. Sunucu kapalı veya internet yok: Sayfa gezintilerinde index.html'e dön
        if (event.request.mode === 'navigate') {
          return caches.match('./index.html') || caches.match('./');
        }
      });
    })
  );
});
