/* ============================================================
   Daily Pilot — Service Worker (PWA)
   راهبرد کش:
   - ناوبری (HTML): Network-First با ذخیره‌ی آخرین نسخه برای حالت آفلاین
   - دارایی‌های استاتیک هم‌ریشه: Stale-While-Revalidate
   - API ها و درخواست‌های RSC هرگز کش نمی‌شوند
   ============================================================ */

const SHELL_CACHE = "dp-shell-v1"
const ASSET_CACHE = "dp-assets-v1"

/* ---------- نصب ---------- */
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.add("/"))
      .catch(() => {
        /* اگر صفحه‌ی اول در دسترس نبود، نصب را متوقف نمی‌کنیم */
      })
      .then(() => self.skipWaiting()),
  )
})

/* ---------- پیام‌ها (SKIP_WAITING از UI به‌روزرسانی) ---------- */
self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting()
})

/* ---------- فعال‌سازی ---------- */
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== SHELL_CACHE && k !== ASSET_CACHE).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  )
})

async function networkFirst(request) {
  const cache = await caches.open(SHELL_CACHE)
  try {
    const fresh = await fetch(request)
    if (fresh && fresh.ok && fresh.type === "basic") {
      cache.put(request, fresh.clone())
    }
    return fresh
  } catch {
    const cached = await cache.match(request)
    if (cached) return cached
    // آفلاین: آخرین صفحه‌ی کش‌شده (معمولاً لندینگ/داشبورد)
    const home = await cache.match("/")
    if (home && request.mode === "navigate") return home
    throw new Error("Network unavailable")
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(ASSET_CACHE)
  const cached = await cache.match(request)
  if (cached) return cached

  try {
    const fresh = await fetch(request)
    if (fresh && fresh.ok && fresh.type === "basic") {
      cache.put(request, fresh.clone())
    }
    return fresh
  } catch {
    return new Response("", { status: 504, statusText: "Offline" })
  }
}

/* ---------- یادآور سرور (Web Push) ---------- */

/**
 * payload استاندارد یادآور (همان قراردادی که app/lib/push/adapter.ts می‌فرستد):
 *   { title, body, url, tag, icon }
 * هرگز به payload اعتماد کامل نمی‌کنیم: هر فیلد نامعتبر به مقدار امن برمی‌گردد.
 */
function readPushPayload(event) {
  const fallback = {
    title: "یادآور روزچین",
    body: "وقت برنامه‌ریزی روزت رسیده است ✨",
    url: "/dashboard",
    tag: "dp-reminder",
    icon: "/icons/icon-192.png",
  }

  try {
    const raw = event.data ? event.data.json() : null
    if (!raw || typeof raw !== "object") return fallback

    const clean = (value, fb, max) =>
      typeof value === "string" && value.trim() !== "" ? value.slice(0, max) : fb

    return {
      title: clean(raw.title, fallback.title, 120),
      body: clean(raw.body, fallback.body, 300),
      url: clean(raw.url, fallback.url, 512),
      tag: clean(raw.tag, fallback.tag, 120),
      icon: clean(raw.icon, fallback.icon, 512),
    }
  } catch {
    // payload غیر-JSON یا خراب → پیام پیش‌فرض
    return fallback
  }
}

self.addEventListener("push", (event) => {
  const payload = readPushPayload(event)

  event.waitUntil(
    (async () => {
      try {
        await self.registration.showNotification(payload.title, {
          body: payload.body,
          icon: payload.icon,
          badge: "/icons/icon-192.png",
          lang: "fa",
          dir: "rtl",
          tag: payload.tag,
          // همان قرارداد notificationclick: data.url مقصد فوکوس/بازشدن است
          data: { url: payload.url },
        })
      } catch {
        /* نمایش اعلان ممکن نبود (مجوز لغو شده/سیستم از کار افتاده) — چیزی برای rollback نیست */
      }
    })(),
  )
})

/* ---------- کلیک روی اعلان یادآور ---------- */

/**
 * مقصد کلیک را از data.url می‌خوانیم.
 * فقط same-origin پذیرفته می‌شود (بدون open-redirect) و در غیر این صورت به
 * داشبورد برمی‌گردیم.
 */
function notificationTarget(notification) {
  const raw = notification && notification.data ? notification.data.url : undefined
  if (typeof raw !== "string" || raw === "") return "/dashboard"

  try {
    const url = new URL(raw, self.location.origin)
    if (url.origin !== self.location.origin) return "/dashboard"
    return url.pathname + url.search
  } catch {
    return "/dashboard"
  }
}

function isSameOriginClient(client, origin) {
  try {
    return new URL(client.url).origin === origin
  } catch {
    return false
  }
}

/**
 * پنجره‌ی باز را فوکوس می‌کند و در صورت نیاز به مقصد منتقل می‌کند.
 *
 * Safari از `client.navigate` پشتیبانی نمی‌کند؛ در آن حالت فقط focus انجام
 * می‌شود (fallback) و پنجره‌ی تازه باز نمی‌شود.
 */
async function focusOrOpen(href) {
  const all = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  })
  const windows = all.filter((client) => isSameOriginClient(client, self.location.origin))

  // اگر پنجره‌ای همین حالا روی مقصد است، فقط فوکوس کافی است
  const onTarget = windows.find((client) => client.url === href)
  const client = onTarget || windows[0]

  if (client) {
    if (!onTarget && typeof client.navigate === "function") {
      try {
        await client.navigate(href)
      } catch {
        /* Safari: navigate پشتیبانی نمی‌شود → فقط focus */
      }
    }

    if (typeof client.focus === "function") {
      await client.focus()
    }
    return
  }

  if (typeof self.clients.openWindow === "function") {
    await self.clients.openWindow(href)
  }
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close()

  const href = new URL(notificationTarget(event.notification), self.location.origin).href

  event.waitUntil(
    (async () => {
      try {
        await focusOrOpen(href)
      } catch {
        /* هیچ راهی برای هدایت کاربر نبود — اعلان بسته شده و کافی است */
      }
    })(),
  )
})

/* ---------- درخواست‌ها ---------- */
self.addEventListener("fetch", (event) => {
  const { request } = event
  if (request.method !== "GET") return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  if (url.pathname.startsWith("/api/")) return
  if (url.searchParams.has("_rsc")) return // درخواست‌های RSC کش نمی‌شوند

  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request))
    return
  }

  event.respondWith(staleWhileRevalidate(request))
})
