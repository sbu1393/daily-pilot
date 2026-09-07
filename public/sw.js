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
