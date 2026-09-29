// AI Quota — اعلام تغییر سهمیه (framework-agnostic)
//
// عمداً یک ماژول plain و بدون `"use client"` است، چون هم لایهٔ UI (کامپوننت‌ها و
// hookها) و هم ماژول‌های orchestration مثل `planProposalFlow` باید بتوانند رویداد را
// پخش کنند. اگر این helper داخل یک فایل `"use client"` می‌بود، import کردنش از یک
// ماژول غیرکلاینت در RSC به یک client-reference proxy تبدیل می‌شد که سمت سرور قابل
// فراخوانی نیست — و ضمناً قاعدهٔ «این ماژول مستقل از framework است» را می‌شکست.

/** نام رویداد سراسری: بعد از هر عملیات AI (موفق یا ناموفق) پخش می‌شود. */
export const AI_QUOTA_CHANGED_EVENT = "ai:quota:changed"

/**
 * اعلام می‌کند سهمیه ممکن است تغییر کرده باشد.
 *
 * الگو همان `planner:mutated` موجود پروژه است، پس UI از لایهٔ data-fetching جداست و
 * مجبور نیست بداند چه کسی سهمیه را کم کرده.
 *
 * نکتهٔ درست‌بودن عدد: release در **سرور** و پیش از ارسال پاسخ انجام می‌شود، پس
 * وقتی این رویداد بعد از پاسخ (موفق یا خطا) پخش می‌شود، عددی که خوانده می‌شود
 * **نهایی** است — نه یک مصرفِ نیمه‌کاره. به همین دلیل فراخوانی در `finally` است.
 *
 * در محیط غیرمرور (تست/سرور) بی‌اثر است.
 */
export function announceAiQuotaChanged(): void {
    if (typeof window === "undefined") return
    window.dispatchEvent(new Event(AI_QUOTA_CHANGED_EVENT))
}
