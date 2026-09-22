/* ============================================================
   روزساز — Service Worker (PWA)
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

/* ============================================================
   ADR-07 / Phase 3-A — دریافت Web Push و نمایش Notification
   - فقط «دریافت»؛ هیچ ارسال/Scheduler در SW نیست.
   - payload نامعتبر هرگز باعث crash نمی‌شود (fail-safe).
   ============================================================ */

const PUSH_ICON = "/icons/icon-192.png"
const PUSH_BADGE = "/icons/maskable-192.png"
const PUSH_DEFAULT_URL = "/dashboard"

/** فقط مسیر داخلی اپ قابل استفاده است (جلوگیری از open redirect). */
function safeInternalPath(value) {
  return typeof value === "string" && value.charAt(0) === "/" ? value : PUSH_DEFAULT_URL
}

self.addEventListener("push", (event) => {
  event.waitUntil(
    (async () => {
      let payload = null
      try {
        payload = event.data ? event.data.json() : null
      } catch {
        payload = null // بدنه‌ی خراب/غیر-JSON → بی‌صدا رد می‌شود
      }

      // اعتبارسنجی حداقلی و fail-safe: payload ناشناخته هرگز notification نمی‌سازد
      if (!payload || typeof payload !== "object") return
      if (payload.type !== "task-reminder" || typeof payload.title !== "string" || payload.title.length === 0) {
        return
      }

      const options = {
        body: typeof payload.body === "string" ? payload.body : "",
        icon: PUSH_ICON,
        badge: PUSH_BADGE,
        data: {
          taskId: payload.taskId != null ? payload.taskId : null,
          url: safeInternalPath(payload.url),
        },
      }
      if (payload.taskId != null) options.tag = `task-reminder-${payload.taskId}`

      await self.registration.showNotification(payload.title, options)
    })(),
  )
})

/* ---------- کلیک روی Notification ---------- */
self.addEventListener("notificationclick", (event) => {
  event.notification.close()

  const data = (event.notification && event.notification.data) || {}
  const targetUrl = new URL(safeInternalPath(data.url), self.location.origin).href

  event.waitUntil(
    (async () => {
      // ۱) اگر پنجره‌ای از همین اپ باز است → همان را focus کن و به مسیر Task برو
      const clientList = await self.clients.matchAll({ type: "window", includeUncontrolled: true })
      for (const client of clientList) {
        let sameOrigin = false
        try {
          sameOrigin = new URL(client.url).origin === self.location.origin
        } catch {
          sameOrigin = false
        }
        if (!sameOrigin) continue

        try {
          await client.focus()
          if (typeof client.navigate === "function" && client.url !== targetUrl) {
            await client.navigate(targetUrl)
          }
        } catch {
          /* focus/navigate ناموفق → پنجره‌ی جدید باز نمی‌کنیم (بدون پنجره‌ی اضافه) */
        }
        return
      }

      // ۲) هیچ پنجره‌ای باز نیست → یک پنجره‌ی جدید باز کن
      await self.clients.openWindow(targetUrl)
    })(),
  )
})
