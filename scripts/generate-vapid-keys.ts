/*
 * تولید کلیدهای VAPID برای Web Push
 * ---------------------------------------------------------------
 * اجرا:  npm run vapid:keys
 *
 * خروجی: کلید عمومی، کلید خصوصی و subject پیشنهادی + یک دستور آمادهٔ
 * `freebuff-env set` (یا سطرهای دستی برای .env) که باید در
 * Settings → Environment وارد شوند.
 *
 * نکته‌ها:
 * - کلیدها یک‌بار تولید می‌شوند و **ثابت** می‌مانند. تغییر کلید خصوصی، همه‌ی
 *   اشتراک‌های موجود را بی‌اعتبار می‌کند (مرورگرها باید دوباره subscribe کنند).
 * - کلید خصوصی هرگز نباید در git، لاگ یا سمت کلاینت برود.
 * - NEXT_PUBLIC_VAPID_PUBLIC_KEY باید در زمان **build** هم موجود باشد
 *   (Next مقادیر NEXT_PUBLIC_* را در باندل inline می‌کند).
 */

import webpush from "web-push"

const keys = webpush.generateVAPIDKeys()
const defaultSubject = "mailto:admin@example.com"

console.log("")
console.log("کلیدهای VAPID تولید شد — این‌ها را در Settings → Environment وارد کن:")
console.log("")
console.log(`NEXT_PUBLIC_VAPID_PUBLIC_KEY=${keys.publicKey}`)
console.log(`VAPID_PRIVATE_KEY=${keys.privateKey}`)
console.log(`VAPID_SUBJECT=${defaultSubject}`)
console.log("")
console.log("یا با یک دستور (کلیدها در فایل env.local ادغام می‌شوند):")
console.log("")
console.log(
    `freebuff-env set --file .env.local '${JSON.stringify({
        NEXT_PUBLIC_VAPID_PUBLIC_KEY: keys.publicKey,
        VAPID_PRIVATE_KEY: keys.privateKey,
        VAPID_SUBJECT: defaultSubject,
    })}'`,
)
console.log("")
console.log("توجه: کلید خصوصی را در چت/گزارش کپی نکن و آن را rotate نکن مگر لازم باشد.")
console.log("")
