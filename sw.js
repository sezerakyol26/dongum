/**
 * Döngüm - Çevrimdışı Çalışma & PWA Hizmet Yöneticisi (Service Worker)
 * - Sunucusuz %100 çevrimdışı çalışma ve önbellek yönetimi
 * - Periodic Background Sync & Background Sync ile uygulama kapalıyken akıllı hatırlatıcılar
 * - Su İçme, Gün Ortası Ruh Hali ve Döngü Faz bildirimleri
 */

const CACHE_NAME = 'dongum-pwa-v29';
const NOTIF_CACHE_NAME = 'dongum-notification-store-v1';
const NOTIF_DATA_URL = 'https://dongum.internal/notification-state.json';

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

// 2. Etkinleştirme (Activate): Eski önbellekleri temizle (bildirim veritabanını koru) ve kontrolü devral
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME && key !== NOTIF_CACHE_NAME && !key.startsWith('dongum-notification-')) {
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

  const data = event.notification.data || {};
  const tab = data.tab || 'home';
  const openDay = data.openDay || '';
  const focus = data.focus || '';

  const targetUrl = `./index.html?tab=${encodeURIComponent(tab)}&openDay=${encodeURIComponent(openDay)}&focus=${encodeURIComponent(focus)}`;

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // Zaten açık bir sekme/pencere varsa onu odakla ve sekmesini değiştir
      for (const client of clientList) {
        if ('focus' in client) {
          client.postMessage({
            type: 'NAVIGATE_TAB',
            tab: tab,
            openDay: openDay,
            focus: focus
          });
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

// 5. Arka Plan Push Desteği (Harici Web Push için Hazır)
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

// 6. Arka Plan Senkronizasyonu (Periodic Background Sync - Uygulama Tamamen Kapalıyken Tetikleyici)
self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'dongum-reminder-sync' || event.tag.startsWith('dongum-')) {
    event.waitUntil(evaluateBackgroundReminders());
  }
});

// 7. Standart Background Sync (Ağ / Cihaz Uyandığında)
self.addEventListener('sync', (event) => {
  if (event.tag === 'dongum-reminder-sync' || event.tag.startsWith('dongum-')) {
    event.waitUntil(evaluateBackgroundReminders());
  }
});

// 8. Uygulama ile Service Worker Arası Mesajlaşma (Sync Payload, Schedule & Tetikleme)
self.addEventListener('message', (event) => {
  if (!event.data) return;

  if (event.data.type === 'SYNC_NOTIFICATION_PAYLOAD') {
    event.waitUntil(
      saveStoredNotificationPayload(event.data.payload).then(() => {
        return evaluateBackgroundReminders();
      })
    );
  } else if (event.data.type === 'PING_EVALUATE') {
    event.waitUntil(evaluateBackgroundReminders());
  } else if (event.data.type === 'SCHEDULE_TEST_NOTIFICATION') {
    const delayMs = (event.data.delaySeconds || 5) * 1000;
    event.waitUntil(
      new Promise((resolve) => {
        setTimeout(async () => {
          try {
            await self.registration.showNotification('🌸 Döngüm - Kilit Ekranı / Arka Plan Testi', {
              body: 'Tebrikler! Döngüm bildirim sistemi telefonunuz kilitliyken ve uygulama kapalıyken başarıyla çalıştı 🎉',
              icon: './apple-touch-icon.png',
              badge: './assets/logo-192.png',
              tag: 'dongum_bg_test_' + Date.now(),
              renotify: true,
              vibrate: [200, 100, 200],
              data: { tab: 'home' }
            });
          } catch (e) {
            console.warn('[SW] Arka plan test bildirimi gösterilemedi:', e);
          }
          resolve();
        }, delayMs);
      })
    );
  } else if (event.data.type === 'SCHEDULE_NOTIFICATIONS') {
    event.waitUntil(scheduleUpcomingNotificationsWithTriggers(event.data.notifications));
  }
});

// Gelecekteki bildirimleri Chromium TimestampTrigger ile işletim sistemi düzeyinde planlama
async function scheduleUpcomingNotificationsWithTriggers(notifications) {
  if (!Array.isArray(notifications)) return;
  const supportsTriggers = ('showTrigger' in Notification.prototype) || (typeof self !== 'undefined' && 'TimestampTrigger' in self);

  for (const notif of notifications) {
    if (!notif.timestamp || notif.timestamp <= Date.now()) continue;

    const options = {
      body: notif.body || '',
      icon: './apple-touch-icon.png',
      badge: './assets/logo-192.png',
      tag: notif.tag || ('dongum_trigger_' + notif.timestamp),
      renotify: true,
      vibrate: [150, 80, 150],
      data: notif.data || { tab: 'home' }
    };

    if (supportsTriggers && typeof TimestampTrigger !== 'undefined') {
      try {
        options.showTrigger = new TimestampTrigger(notif.timestamp);
        await self.registration.showNotification(notif.title, options);
      } catch (err) {
        // Cihaz kısıtlaması varsa sessizce devam et
      }
    }
  }
}

// =========================================================================
// ARKA PLAN BİLDİRİM DEPOLAMA VE DEĞERLENDİRME MANTIĞI
// =========================================================================
async function getStoredNotificationPayload() {
  try {
    const cache = await caches.open(NOTIF_CACHE_NAME);
    const res = await cache.match(NOTIF_DATA_URL);
    if (res) {
      return await res.json();
    }
  } catch (e) {
    console.warn('[SW] Bildirim verisi okunamadı:', e);
  }
  return null;
}

async function saveStoredNotificationPayload(payload) {
  try {
    const cache = await caches.open(NOTIF_CACHE_NAME);
    await cache.put(
      new Request(NOTIF_DATA_URL),
      new Response(JSON.stringify(payload), {
        headers: { 'Content-Type': 'application/json' }
      })
    );
  } catch (e) {
    console.warn('[SW] Bildirim verisi kaydedilemedi:', e);
  }
}

function formatDateStr(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

async function evaluateBackgroundReminders() {
  const payload = await getStoredNotificationPayload();
  if (!payload || !payload.settings || payload.settings.enabled === false) {
    return;
  }

  const now = new Date();
  const todayStr = formatDateStr(now);
  const currentHours = now.getHours();
  const currentMinutes = now.getMinutes();
  const currentTimeStr = `${String(currentHours).padStart(2, '0')}:${String(currentMinutes).padStart(2, '0')}`;

  const settings = payload.settings;
  const sentLog = payload.sentLog || {};
  let changed = false;

  // Yeni bir güne geçildiyse durumları tazele
  if (payload.todayStr !== todayStr) {
    payload.todayStr = todayStr;
    payload.todayWater = 0;
    payload.hasLoggedMood = false;
    payload.hasLoggedDaily = false;
    changed = true;
  }

  // 1. SU İÇME HATIRLATMASI (Gündüz saatlerinde periyodik su uyarısı)
  if (settings.waterReminder !== false) {
    const startHour = settings.waterStartHour || 8;
    const endHour = settings.waterEndHour || 22;

    if (currentHours >= startHour && currentHours <= endHour) {
      const todayWater = payload.todayWater || 0;
      const targetWater = settings.waterTarget || 2250;

      if (todayWater < targetWater) {
        const intervalHours = parseFloat(settings.waterIntervalHours) || 2;
        const intervalMs = Math.round(intervalHours * 60 * 60 * 1000);
        const lastWaterTime = sentLog.lastWaterNoticeTime || 0;

        if (now.getTime() - lastWaterTime >= intervalMs) {
          const remaining = Math.max(0, targetWater - todayWater);
          const title = '💧 Döngüm - Su İçme Vakti';
          const body = `Vücudunu nemli tut! Hedefine ${remaining} ml kaldı. Bir bardak su içerek tazelenin (${todayWater}/${targetWater} ml).`;

          await self.registration.showNotification(title, {
            body: body,
            icon: './apple-touch-icon.png',
            badge: './assets/logo-192.png',
            tag: 'water_reminder',
            renotify: true,
            vibrate: [150, 80, 150],
            data: { tab: 'fitness', timestamp: now.getTime() }
          });

          sentLog.lastWaterNoticeTime = now.getTime();
          changed = true;
        }
      }
    }
  }

  // 2. GÜN ORTASI RUH HALİ HATIRLATMASI (Kullanıcının belirlediği saatte, örn: 15:00)
  if (settings.moodReminder !== false) {
    const moodTargetTime = settings.moodReminderTime || '15:00';
    const isPastMoodTime = currentTimeStr >= moodTargetTime;

    if (isPastMoodTime && !payload.hasLoggedMood) {
      const logKey = `mood_${todayStr}`;
      if (!sentLog[logKey]) {
        const title = '🧘 Döngüm - Ruh Halini Kaydet';
        const body = 'Bugün nasıl hissediyorsun? Günlük ruh halini ve enerjini 5 saniyede kaydederek döngü dengeni takip et.';

        await self.registration.showNotification(title, {
          body: body,
          icon: './apple-touch-icon.png',
          badge: './assets/logo-192.png',
          tag: 'mood_reminder',
          renotify: true,
          vibrate: [120, 60, 120],
          data: { tab: 'calendar', openDay: todayStr, focus: 'mood', timestamp: now.getTime() }
        });

        sentLog[logKey] = now.getTime();
        changed = true;
      }
    }
  }

  // 3. GÜN SONU SAĞLIK & SEMPTOM KAYDI HATIRLATMASI (Örn: 20:30)
  if (settings.dailyLogReminder !== false) {
    const dailyTargetTime = settings.dailyLogTime || '20:30';
    const isPastDailyTime = currentTimeStr >= dailyTargetTime;

    if (isPastDailyTime && !payload.hasLoggedDaily) {
      const logKey = `daily_log_${todayStr}`;
      if (!sentLog[logKey]) {
        const title = '📝 Döngüm - Günün Sağlık Kaydı';
        const body = 'Bugün nasıl hissettin? Günlük semptom, duygu ve akıntı kaydını eklemeyi unutma.';

        await self.registration.showNotification(title, {
          body: body,
          icon: './apple-touch-icon.png',
          badge: './assets/logo-192.png',
          tag: 'daily_health_log',
          renotify: true,
          vibrate: [100, 50, 100],
          data: { tab: 'calendar', openDay: todayStr, timestamp: now.getTime() }
        });

        sentLog[logKey] = now.getTime();
        changed = true;
      }
    }
  }

  // 4. YAKLAŞAN REGL HATIRLATMASI (Arka Planda)
  if (settings.periodReminder !== false && typeof payload.daysUntilNext === 'number') {
    const daysUntilNext = payload.daysUntilNext;
    const threshold = settings.periodReminderDays || 2;

    if (daysUntilNext > 0 && daysUntilNext <= threshold) {
      const logKey = `period_approaching_${todayStr}_${payload.nextPeriodDate || ''}`;
      if (!sentLog[logKey]) {
        const title = '🌸 Döngüm - Regl Dönemi Yaklaşıyor';
        const dayText = daysUntilNext === 1 ? 'yarın' : `${daysUntilNext} gün içinde`;
        const body = `Tahmini regl başlangıcınız ${dayText} bekleniyor. Hazırlıklarınızı yapmayı unutmayın!`;

        await self.registration.showNotification(title, {
          body: body,
          icon: './apple-touch-icon.png',
          badge: './assets/logo-192.png',
          tag: 'period_approaching',
          renotify: true,
          data: { tab: 'calendar', timestamp: now.getTime() }
        });

        sentLog[logKey] = now.getTime();
        changed = true;
      }
    }
  }

  // 5. OVÜLASYON ZİRVESİ HATIRLATMASI
  if (settings.ovulationReminder !== false && payload.phase === 'ovulation') {
    const logKey = `ovulation_${todayStr}`;
    if (!sentLog[logKey]) {
      const title = '✨ Döngüm - Yumurtlama (Ovülasyon) Günü';
      const body = 'Bugün gebe kalma ihtimalinin en yüksek olduğu zirve ovülasyon evresindesiniz.';

      await self.registration.showNotification(title, {
        body: body,
        icon: './apple-touch-icon.png',
        badge: './assets/logo-192.png',
        tag: 'ovulation_day',
        renotify: true,
        data: { tab: 'home', timestamp: now.getTime() }
      });

      sentLog[logKey] = now.getTime();
      changed = true;
    }
  }

  if (changed) {
    payload.sentLog = sentLog;
    await saveStoredNotificationPayload(payload);
  }
}
