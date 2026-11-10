/**
 * Döngüm - Çevrimdışı Çalışma & PWA Hizmet Yöneticisi (Service Worker v2 - Optimize)
 * - Sunucusuz %100 çevrimdışı çalışma ve önbellek yönetimi
 * - Periodic Background Sync & Background Sync ile uygulama kapalıyken akıllı hatırlatıcılar
 * - Tekilleştirilmiş TimestampTrigger planlayıcı, Gece Sessiz Saatler koruması ve Hızlı Ekle (+) entegrasyonu
 */

const CACHE_NAME = 'dongum-pwa-v38';
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
      try {
        await cache.addAll(['./', './index.html', './manifest.webmanifest']);
      } catch (err) {
        console.warn('Temel çekirdek önbelleğe alınırken uyarı:', err);
      }
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
        } catch (e) {}
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
    }).then(async () => {
      await self.clients.claim();
      await restoreAndArmBackgroundSchedule();
    })
  );
});

// 3. İstek Yakalama (Fetch): Önbellek Öncelikli (Cache-First) + Çevrimdışı Gezinti Garantisi
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        fetch(event.request).then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, networkResponse);
            });
          }
        }).catch(() => {});

        return cachedResponse;
      }

      return fetch(event.request).then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200) {
          const responseClone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseClone);
          });
        }
        return networkResponse;
      }).catch(async () => {
        if (event.request.mode === 'navigate') {
          const fallback = await caches.match('./index.html');
          if (fallback) return fallback;
          return await caches.match('./');
        }
      });
    })
  );
});

// 4. Bildirime Tıklama (Notification Click): Uygulamayı öne getir veya Hızlı Ekle (+) modalını aç
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const data = event.notification.data || {};
  const tab = data.tab || 'home';
  const openDay = data.openDay || '';
  const focus = data.focus || '';
  const openQuickAdd = data.openQuickAdd ? '1' : '';
  const quickSection = data.quickSection || '';

  const targetUrl = `./index.html?tab=${encodeURIComponent(tab)}&openDay=${encodeURIComponent(openDay)}&focus=${encodeURIComponent(focus)}&openQuickAdd=${encodeURIComponent(openQuickAdd)}&quickSection=${encodeURIComponent(quickSection)}`;

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          client.postMessage({
            type: 'NAVIGATE_TAB',
            tab: tab,
            openDay: openDay,
            focus: focus,
            openQuickAdd: !!data.openQuickAdd,
            quickSection: quickSection
          });
          return client.focus();
        }
      }
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

// Arka plan bellek içi zamanlayıcı havuzu (TimestampTrigger desteklemeyen tarayıcılar için SW Alarm Motoru)
let swActiveTimers = [];
let swTickerInterval = null;
let isSwEvaluating = false;

function ensureSwBackgroundTicker() {
  if (swTickerInterval) return;
  swTickerInterval = setInterval(() => {
    evaluateBackgroundReminders();
  }, 60 * 1000);
}

// 6. Arka Plan Senkronizasyonu (Periodic Background Sync)
self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'dongum-reminder-sync' || event.tag.startsWith('dongum-')) {
    event.waitUntil(
      restoreAndArmBackgroundSchedule().then(() => evaluateBackgroundReminders())
    );
  }
});

// 7. Standart Background Sync
self.addEventListener('sync', (event) => {
  if (event.tag === 'dongum-reminder-sync' || event.tag.startsWith('dongum-')) {
    event.waitUntil(
      restoreAndArmBackgroundSchedule().then(() => evaluateBackgroundReminders())
    );
  }
});

// 8. Uygulama ile Service Worker Arası Mesajlaşma
self.addEventListener('message', (event) => {
  if (!event.data) return;

  if (event.data.type === 'SYNC_NOTIFICATION_PAYLOAD') {
    const incomingPayload = event.data.payload || {};
    if (Array.isArray(event.data.scheduledNotifications)) {
      incomingPayload.scheduledNotifications = event.data.scheduledNotifications;
    }
    event.waitUntil(
      saveStoredNotificationPayload(incomingPayload).then(async () => {
        if (Array.isArray(incomingPayload.scheduledNotifications)) {
          await scheduleUpcomingNotificationsWithTriggers(incomingPayload.scheduledNotifications);
        }
        if (event.data.evaluateNow) {
          await evaluateBackgroundReminders();
        }
        if (Array.isArray(incomingPayload.scheduledNotifications)) {
          await waitForNearUpcomingAlarm(incomingPayload.scheduledNotifications);
        }
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
            await self.registration.showNotification('🌸 Döngüm - Kilit Ekranı / Arka Plan Testi ✨', {
              body: 'Tebrikler! Döngüm bildirim sistemi telefonunuz kilitliyken ve uygulama kapalıyken başarıyla çalıştı 🎉',
              icon: './apple-touch-icon.png',
              badge: './assets/logo-192.png',
              tag: 'dongum_bg_test_' + Date.now(),
              renotify: true,
              vibrate: [200, 100, 200],
              data: { tab: 'home', openQuickAdd: true }
            });
          } catch (e) {
            console.warn('[SW] Arka plan test bildirimi gösterilemedi:', e);
          }
          resolve();
        }, delayMs);
      })
    );
  } else if (event.data.type === 'SCHEDULE_NOTIFICATIONS') {
    event.waitUntil(
      (async () => {
        const notifications = event.data.notifications || [];
        const payload = (await getStoredNotificationPayload()) || {};
        payload.scheduledNotifications = notifications;
        await saveStoredNotificationPayload(payload);
        await scheduleUpcomingNotificationsWithTriggers(notifications);
        await waitForNearUpcomingAlarm(notifications);
      })()
    );
  }
});

// Yakın vadede (önümüzdeki 4.5 dakika içinde) çalacak bir bildirim varsa SW'nin uyutulmasını engelle
function waitForNearUpcomingAlarm(notifications) {
  if (!Array.isArray(notifications) || notifications.length === 0) return Promise.resolve();
  const nowMs = Date.now();
  const nextNotif = notifications.find(n => n && n.timestamp && n.timestamp > nowMs && (n.timestamp - nowMs) <= 270 * 1000);
  if (!nextNotif) return Promise.resolve();
  const waitMs = Math.max(1000, (nextNotif.timestamp - nowMs) + 600);
  return new Promise((resolve) => {
    setTimeout(async () => {
      await fireScheduledSwNotification(nextNotif);
      resolve();
    }, waitMs);
  });
}

// Service Worker uyandığında önbellekteki zamanlanmış bildirimleri yükle ve alarmları kur
async function restoreAndArmBackgroundSchedule() {
  ensureSwBackgroundTicker();
  try {
    const payload = await getStoredNotificationPayload();
    if (payload && Array.isArray(payload.scheduledNotifications)) {
      armSwMemoryAlarms(payload.scheduledNotifications);
    }
  } catch (e) {}
}

// Tarayıcı TimestampTrigger desteklese de desteklemese de SW bellek içi setTimeout alarmlarını kurar
function armSwMemoryAlarms(notifications) {
  if (!Array.isArray(notifications)) return;
  ensureSwBackgroundTicker();

  // Önceki bellek içi zamanlayıcıları temizle
  for (const tid of swActiveTimers) {
    clearTimeout(tid);
  }
  swActiveTimers = [];

  const nowMs = Date.now();
  // Önümüzdeki 12 saat içindeki en yakın 12 bildirimi zamanla
  const upcoming = notifications
    .filter(n => n && n.timestamp && n.timestamp > nowMs && (n.timestamp - nowMs) <= 12 * 3600 * 1000)
    .slice(0, 12);

  for (const notif of upcoming) {
    const delay = Math.max(1000, notif.timestamp - nowMs);
    const timerId = setTimeout(() => {
      fireScheduledSwNotification(notif);
    }, delay);
    swActiveTimers.push(timerId);
  }
}

async function fireScheduledSwNotification(notif) {
  if (!notif) return;
  try {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const hasFocusedClient = clients.some(c => c.focused);
    if (hasFocusedClient) return;

    const payload = await getStoredNotificationPayload();
    if (payload && payload.settings && payload.settings.enabled === false) return;
    if (payload && payload.settings && isQuietHours(payload.settings, new Date())) return;

    const sentLog = (payload && payload.sentLog) ? payload.sentLog : {};
    const nowMs = Date.now();
    const MIN_COOLDOWN_MS = 10 * 60 * 1000;

    if (notif.logKey && sentLog[notif.logKey]) return;
    if (sentLog.lastSystemNotifAt && (nowMs - sentLog.lastSystemNotifAt) < MIN_COOLDOWN_MS) return;

    // Eğer kullanıcı bu veriyi zaten girdiyse iptal et
    if (payload) {
      if (notif.notifType === 'mood' && payload.hasLoggedMood) return;
      if (notif.notifType === 'exercise' && payload.hasLoggedExercise) return;
      if (notif.notifType === 'daily' && payload.hasLoggedDaily) return;
      if (notif.notifType === 'water' && (payload.todayWater || 0) >= (payload.settings?.waterTarget || 2250)) return;
    }

    await self.registration.showNotification(notif.title, {
      body: notif.body || '',
      icon: './apple-touch-icon.png',
      badge: './assets/logo-192.png',
      tag: notif.tag || ('sched_dongum_' + nowMs),
      renotify: true,
      vibrate: [150, 80, 150],
      data: notif.data || { tab: 'home', openQuickAdd: true }
    });

    if (payload) {
      payload.sentLog = sentLog;
      if (notif.logKey) payload.sentLog[notif.logKey] = nowMs;
      if (notif.notifType === 'water') payload.sentLog.lastWaterNoticeTime = nowMs;
      payload.sentLog.lastSystemNotifAt = nowMs;
      await saveStoredNotificationPayload(payload);
    }
  } catch (e) {}
}

// Gelecekteki bildirimleri hem SW bellek alarmlarıyla hem de (destekleniyorsa) Chromium TimestampTrigger ile planla
async function scheduleUpcomingNotificationsWithTriggers(notifications) {
  if (!Array.isArray(notifications)) return;

  // 1. Her durumda Service Worker bellek alarmlarını ve arka plan döngüsünü kur
  armSwMemoryAlarms(notifications);

  // 2. Cihaz TimestampTrigger destekliyorsa işletim sistemi düzeyinde de kur
  const supportsTriggers = ('showTrigger' in Notification.prototype) || (typeof self !== 'undefined' && 'TimestampTrigger' in self);
  if (!supportsTriggers || typeof TimestampTrigger === 'undefined') return;

  try {
    if (self.registration && typeof self.registration.getNotifications === 'function') {
      const existing = await self.registration.getNotifications({ includeTriggered: true });
      for (const n of existing) {
        if (n.tag && n.tag.startsWith('sched_')) {
          n.close();
        }
      }
    }
  } catch (e) {}

  for (const notif of notifications) {
    if (!notif.timestamp || notif.timestamp <= Date.now()) continue;

    const options = {
      body: notif.body || '',
      icon: './apple-touch-icon.png',
      badge: './assets/logo-192.png',
      tag: notif.tag || ('sched_dongum_' + notif.timestamp),
      renotify: true,
      vibrate: [150, 80, 150],
      data: notif.data || { tab: 'home' }
    };

    try {
      options.showTrigger = new TimestampTrigger(notif.timestamp);
      await self.registration.showNotification(notif.title, options);
    } catch (err) {}
  }
}

// =========================================================================
// ARKA PLAN BİLDİRİM DEPOLAMA VE DEĞERLENDİRME MANTIĞI (TEKİL & PENCERE KORUMALI)
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
  if (!payload) return;
  try {
    const cache = await caches.open(NOTIF_CACHE_NAME);
    try {
      const existingRes = await cache.match(NOTIF_DATA_URL);
      if (existingRes) {
        const existing = await existingRes.json();
        if (existing && existing.sentLog) {
          payload.sentLog = payload.sentLog || {};
          for (const [k, v] of Object.entries(existing.sentLog)) {
            if (!payload.sentLog[k] || payload.sentLog[k] < v) {
              payload.sentLog[k] = v;
            }
          }
        }
        if (!payload.scheduledNotifications && existing && Array.isArray(existing.scheduledNotifications)) {
          payload.scheduledNotifications = existing.scheduledNotifications;
        }
      }
    } catch (err) {}

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

function isQuietHours(settings = {}, dateObj = new Date()) {
  if (settings.quietHoursEnabled === false) return false;
  const startH = typeof settings.quietStartHour === 'number' ? settings.quietStartHour : 23;
  const endH = typeof settings.quietEndHour === 'number' ? settings.quietEndHour : 8;
  const hour = dateObj.getHours();
  if (startH > endH) {
    return hour >= startH || hour < endH;
  } else if (startH < endH) {
    return hour >= startH && hour < endH;
  }
  return false;
}

async function evaluateBackgroundReminders() {
  if (isSwEvaluating) return;
  isSwEvaluating = true;

  try {
    // Yalnızca kullanıcı aktif olarak uygulama penceresine odaklanmışsa (focused) arka plan bildirimini durdur
    try {
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const hasFocusedClient = clients.some(c => c.focused);
      if (hasFocusedClient) {
        isSwEvaluating = false;
        return;
      }
    } catch (e) {}

    const payload = await getStoredNotificationPayload();
    if (!payload || !payload.settings || payload.settings.enabled === false) {
      isSwEvaluating = false;
      return;
    }

    const now = new Date();
    const nowMs = now.getTime();
    const todayStr = formatDateStr(now);
    const currentHours = now.getHours();
    const currentMinutes = now.getMinutes();
    const currentTotalMinutes = currentHours * 60 + currentMinutes;

    const settings = payload.settings;
    if (isQuietHours(settings, now)) {
      isSwEvaluating = false;
      return;
    }

    const sentLog = payload.sentLog || {};
    let changed = false;
    let dispatchedInThisPass = 0;
    const MIN_COOLDOWN_MS = 10 * 60 * 1000; // İki bildirim arası en az 10 dakika

    const canSendNow = () => {
      if (dispatchedInThisPass > 0) return false;
      const lastAt = sentLog.lastSystemNotifAt || 0;
      return (nowMs - lastAt) >= MIN_COOLDOWN_MS;
    };

    const sendSingleSwNotif = async (logKey, title, body, tag, dataObj) => {
      if (!canSendNow()) return false;
      dispatchedInThisPass++;
      sentLog[logKey] = nowMs;
      sentLog.lastSystemNotifAt = nowMs;
      changed = true;

      await self.registration.showNotification(title, {
        body: body,
        icon: './apple-touch-icon.png',
        badge: './assets/logo-192.png',
        tag: tag,
        renotify: true,
        vibrate: [150, 80, 150],
        data: dataObj
      });
      return true;
    };

    // Yeni bir güne geçildiyse durumları tazele
    if (payload.todayStr !== todayStr) {
      payload.todayStr = todayStr;
      payload.todayWater = 0;
      payload.hasLoggedMood = false;
      payload.hasLoggedExercise = false;
      payload.hasLoggedDaily = false;
      changed = true;
    }

    // 1. GÜN ORTASI RUH HALİ HATIRLATMASI (Yalnızca hedef saatten sonraki 45 dk içinde gönder; eskiyse sessizce işaretle)
    if (settings.moodReminder !== false && !payload.hasLoggedMood) {
      const [mH, mM] = (settings.moodReminderTime || '15:00').split(':').map(Number);
      const diffMood = currentTotalMinutes - (mH * 60 + mM);
      const logKey = `mood_${todayStr}`;

      if (diffMood >= 0 && !sentLog[logKey]) {
        if (diffMood <= 45) {
          await sendSingleSwNotif(
            logKey,
            '🧘‍♀️ Döngüm - Ruh Halini Kaydet ✨',
            'Bugün nasıl hissediyorsun? Günlük ruh halini ve enerjini (+) butonundan 5 saniyede kaydet.',
            'mood_reminder',
            { tab: 'home', openQuickAdd: true, quickSection: 'mood', timestamp: nowMs }
          );
        } else {
          // Vakti çoktan geçmişse sessizce işaretle ki sonradan toplu bildirim olarak patlamasın
          sentLog[logKey] = nowMs;
          changed = true;
        }
      }
    }

    // 2. GÜNLÜK EGZERSİZ HATIRLATMASI (Hedef saatten sonraki 45 dk içinde)
    if (settings.exerciseReminder !== false && !payload.hasLoggedExercise) {
      const [eH, eM] = (settings.exerciseReminderTime || '18:00').split(':').map(Number);
      const diffEx = currentTotalMinutes - (eH * 60 + eM);
      const logKey = `exercise_${todayStr}`;

      if (diffEx >= 0 && !sentLog[logKey]) {
        if (diffEx <= 45) {
          await sendSingleSwNotif(
            logKey,
            '🏃‍♀️ Döngüm - Günün Hareket & Egzersiz Vakti 💪',
            'Bedenini döngü fazına uygun bir yürüyüş, yoga veya esneme ile canlandır!',
            'exercise_reminder',
            { tab: 'home', openQuickAdd: true, quickSection: 'exercise', timestamp: nowMs }
          );
        } else {
          sentLog[logKey] = nowMs;
          changed = true;
        }
      }
    }

    // 3. GÜN SONU SAĞLIK & SEMPTOM KAYDI HATIRLATMASI (Hedef saatten sonraki 45 dk içinde)
    if (settings.dailyLogReminder !== false && !payload.hasLoggedDaily) {
      const [dH, dM] = (settings.dailyLogTime || '20:30').split(':').map(Number);
      const diffDaily = currentTotalMinutes - (dH * 60 + dM);
      const logKey = `daily_log_${todayStr}`;

      if (diffDaily >= 0 && !sentLog[logKey]) {
        if (diffDaily <= 45) {
          await sendSingleSwNotif(
            logKey,
            '📝 Döngüm - Günün Sağlık Kaydı 🌸',
            'Bugün nasıl hissettin? Günlük semptom, duygu ve su/egzersiz kaydını (+) menüsünden eklemeyi unutma.',
            'daily_health_log',
            { tab: 'home', openQuickAdd: true, quickSection: 'all', timestamp: nowMs }
          );
        } else {
          sentLog[logKey] = nowMs;
          changed = true;
        }
      }
    }

    // 4. SU İÇME HATIRLATMASI (Gündüz saatlerinde periyodik su uyarısı)
    if (settings.waterReminder !== false && canSendNow()) {
      const startHour = settings.waterStartHour || 8;
      const endHour = settings.waterEndHour || 22;

      if (currentHours >= startHour && currentHours <= endHour) {
        const todayWater = payload.todayWater || 0;
        const targetWater = settings.waterTarget || 2250;

        if (todayWater < targetWater) {
          const intervalHours = parseFloat(settings.waterIntervalHours) || 2;
          const intervalMs = Math.round(intervalHours * 60 * 60 * 1000);
          const lastWaterTime = sentLog.lastWaterNoticeTime || 0;

          if (nowMs - lastWaterTime >= intervalMs) {
            const remaining = Math.max(0, targetWater - todayWater);
            const sent = await sendSingleSwNotif(
              `water_slot_${todayStr}_${currentHours}`,
              '💧 Döngüm - Su İçme Vakti 🌊',
              `Vücudunu nemli tut! Hedefine ${remaining} ml kaldı. Bir bardak su içerek tazelen (${todayWater}/${targetWater} ml).`,
              'water_reminder',
              { tab: 'home', openQuickAdd: true, quickSection: 'water', timestamp: nowMs }
            );
            if (sent) {
              sentLog.lastWaterNoticeTime = nowMs;
            }
          }
        }
      }
    }

    // 5. YAKLAŞAN REGL HATIRLATMASI (Sabah 09:00 - 11:00 penceresinde)
    if (currentHours >= 9 && currentHours <= 11 && settings.periodReminder !== false && typeof payload.daysUntilNext === 'number') {
      const daysUntilNext = payload.daysUntilNext;
      const threshold = settings.periodReminderDays || 2;

      if (daysUntilNext > 0 && daysUntilNext <= threshold) {
        const logKey = `period_approaching_${todayStr}_${payload.nextPeriodDate || ''}`;
        if (!sentLog[logKey]) {
          const dayText = daysUntilNext === 1 ? 'yarın' : `${daysUntilNext} gün içinde`;
          await sendSingleSwNotif(
            logKey,
            '🌸 Döngüm - Regl Dönemi Yaklaşıyor 🩸',
            `Tahmini regl başlangıcınız ${dayText} bekleniyor. Hazırlıklarınızı yapmayı unutmayın!`,
            'period_approaching',
            { tab: 'calendar', timestamp: nowMs }
          );
        }
      }
    }

    // 6. OVÜLASYON ZİRVESİ HATIRLATMASI (Sabah 09:00 - 11:00 penceresinde)
    if (currentHours >= 9 && currentHours <= 11 && settings.ovulationReminder !== false && payload.phase === 'ovulation') {
      const logKey = `ovulation_${todayStr}`;
      if (!sentLog[logKey]) {
        await sendSingleSwNotif(
          logKey,
          '✨ Döngüm - Yumurtlama (Ovülasyon) Günü 🥚',
          'Bugün gebe kalma ihtimalinin en yüksek olduğu zirve ovülasyon evresindesiniz.',
          'ovulation_day',
          { tab: 'home', timestamp: nowMs }
        );
      }
    }

    if (changed) {
      payload.sentLog = sentLog;
      await saveStoredNotificationPayload(payload);
    }
  } finally {
    isSwEvaluating = false;
  }
}
