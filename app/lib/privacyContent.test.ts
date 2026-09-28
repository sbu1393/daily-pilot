import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/* ------------------------------------------------------------------ */
/* سیاست حریم خصوصی — محتوا و منطقِ خالص                              */
/*                                                                     */
/* این repo jsdom ندارد (قیدِ بدون وابستگی جدید)، پس محتوای سیاست در  */
/* `privacyContent.ts` خالص نگه داشته شده و همین‌جا تست می‌شود — دقیقاً  */
/* همان الگوی `faqContent.test.ts` و `createTaskForm.test.ts`.          */
/*                                                                     */
/* دو دسته قید اینجا نگه داشته می‌شود:                                  */
/*   1. «ادعای بی‌پشتوانه» — چیزی که از کد قابل اثبات نیست.          */
/*   2. «اصطلاح فنی» — متن برای کاربر عادی است، نه برنامه‌نویس، پس   */
/*      نام سرویس‌دهنده‌ی هوش مصنوعی و واژه‌های فنی نباید دیده شوند. */
/* ------------------------------------------------------------------ */

import {
    BRAND,
    CONTACT_LINKS,
    LAST_UPDATED,
    PRIVACY_SECTIONS,
    SETTINGS_PRIVACY_PARAGRAPHS,
    SUPPORT_EMAIL,
    findPrivacySection,
    flattenSection,
    privacyFullText,
} from "./privacyContent"

describe("Privacy content — ساختار", () => {
    it("has every section the /privacy page must render", () => {
        const ids = PRIVACY_SECTIONS.map((s) => s.id)
        const required = [
            "intro",
            "collected",
            "usage",
            "tasks",
            "ai",
            "third-party",
            "payment",
            "device",
            "security",
            "retention",
            "deletion",
            "children",
            "changes",
            "contact",
        ]
        for (const id of required) {
            expect(ids, `بخش «${id}» نباید جا بیفتد`).toContain(id)
        }
    })

    it("has unique ids so every table-of-contents anchor is unambiguous", () => {
        const ids = PRIVACY_SECTIONS.map((s) => s.id)
        expect(new Set(ids).size).toBe(ids.length)
    })

    it("gives every section a title and at least one non-empty block", () => {
        for (const section of PRIVACY_SECTIONS) {
            expect(section.title.trim().length, section.id).toBeGreaterThan(0)
            expect(section.blocks.length, section.id).toBeGreaterThan(0)
            for (const block of section.blocks) {
                if (block.kind === "p") {
                    expect(block.text.trim().length, section.id).toBeGreaterThan(0)
                } else {
                    expect(block.items.length, section.id).toBeGreaterThan(0)
                    for (const item of block.items) {
                        expect(item.trim().length, section.id).toBeGreaterThan(0)
                    }
                }
            }
        }
    })

    it("finds a section by id and returns undefined for an unknown one", () => {
        expect(findPrivacySection("ai")?.title).toBe("قابلیت‌های هوش مصنوعی")
        expect(findPrivacySection("nope")).toBeUndefined()
    })
})

describe("Privacy content — بدون اصطلاح فنی (متن برای کاربر عادی است)", () => {
    const text = privacyFullText()

    it("does not name the AI provider or any domain", () => {
        // ایمیل پشتیبانی خودش یک دامنه دارد و طبق سیاست باید بماند؛
        // برای بررسی بقیه، ایمیل رسمی از متن جدا می‌شود.
        const withoutContact = text.split(SUPPORT_EMAIL).join("")
        for (const forbidden of [
            "1xai",
            "openai",
            "gpt-4",
            "gpt-",
            ".ir",
            "zarinpal",
            "resend",
            "vercel",
            "cloudflare",
            "resend",
        ]) {
            expect(
                withoutContact.toLowerCase().includes(forbidden.toLowerCase()),
                forbidden,
            ).toBe(false)
        }
    })

    it("uses no implementation jargon", () => {
        for (const forbidden of [
            "API",
            "endpoint",
            "Service Worker",
            "Cache API",
            "Local Storage",
            "localStorage",
            "Push",
            "OTP",
            "JWT",
            "token",
            "httpOnly",
            "SameSite",
            "ProductEvent",
            "ErrorLog",
            "AiUsage",
            "schema",
            "database",
            "hash",
            "merchant",
            "authority",
            "callback",
        ]) {
            expect(text.includes(forbidden), `اصطلاح فنی نباید در متن باشد: ${forbidden}`).toBe(
                false,
            )
        }
    })

    it("explains the cookie in plain language instead of attribute names", () => {
        expect(text).toContain("کوکی امن")
    })
})

describe("Privacy content — ادعاهای ممنوع", () => {
    const text = privacyFullText()

    it("does not invent a retention period in days", () => {
        // «۳۰ روز»، «۹۰ روز»، «۳۶۵ روز» یا معادل لاتینش — هیچ‌کدام در کد
        // تعریف نشده‌اند، پس وعده‌شان دادن ادعای بی‌پشتوانه است.
        for (const claim of ["۳۰ روز", "۹۰ روز", "۳۶۵ روز", "30 روز", "90 روز", "365 روز"]) {
            expect(text.includes(claim), `ادعای retention نباید باشد: ${claim}`).toBe(false)
        }
    })

    it("does not promise a self-service account deletion that does not exist", () => {
        expect(text.includes("از تنظیمات می‌توانید حساب")).toBe(false)
        expect(text.includes("در صورت فراهم بودن")).toBe(false)
        // در عوض باید صریح بگوید که وجود ندارد.
        expect(text).toContain("حذف کامل حساب")
    })

    it("does not promise a data export that does not exist", () => {
        expect(text).toContain("خروجی کامل")
    })

    it("does not mention a Task description field (no such column exists)", () => {
        expect(text.includes("توضیحات Task")).toBe(false)
        expect(text.includes("description")).toBe(false)
    })

    it("uses no unprovable legal or commercial claim", () => {
        for (const claim of ["مالکیت", "فروخته نمی‌شود", "واگذار نمی‌شود", "امنیت کامل", "رمزنگاری کامل"]) {
            expect(text.includes(claim), claim).toBe(false)
        }
    })

    it("does not make an unprovable promise about provider access limits", () => {
        expect(text.includes("فقط در حدی که برای کارش لازم است")).toBe(false)
    })

    it("does not tell the user data is withheld from them", () => {
        expect(text.includes("در اختیار شما قرار نمی‌گیرند")).toBe(false)
    })

    it("does not invent a minimum age or say the service is for adults", () => {
        for (const claim of ["۱۳ سال", "۱۶ سال", "۱۸ سال", "بزرگسالان"]) {
            expect(text.includes(claim), `سن یا مخاطبِ ادعاشده: ${claim}`).toBe(false)
        }
        expect(text).toContain("حداقل سن مشخص و اعلام‌شده‌ای")
    })

    it("does not claim every change will be announced by email", () => {
        expect(text.includes("از طریق ایمیل به شما اطلاع")).toBe(false)
    })

    it("leaves no placeholder contact details", () => {
        for (const placeholder of ["[", "]", "TODO", "example.com", "your-email"]) {
            expect(text.includes(placeholder), `placeholder باقی مانده: ${placeholder}`).toBe(false)
        }
    })

    it("keeps the brand name consistent (no leftover placeholder brand)", () => {
        expect(text).toContain(BRAND)
        for (const wrong of ["روزسان", "Daily Pilot", "روزسااز"]) {
            expect(text.includes(wrong), wrong).toBe(false)
        }
    })
})

describe("Privacy content — محتوای لازم که باید در متن باشد", () => {
    const text = privacyFullText()

    it("describes the AI flow in plain language, including what is NOT sent", () => {
        expect(text).toContain("سرویس پردازش هوش مصنوعی")
        expect(text).toContain("عنوان همان کار")
        expect(text).toContain("دسته‌بندی")
        expect(text).toContain("اولویت")
        expect(text).toContain("امتیاز")
        expect(text).toContain("ارسال نمی‌شود")
        for (const field of ["ایمیل", "شماره تلفن", "تصویر پروفایل"]) {
            expect(text.includes(field), field).toBe(true)
        }
    })

    it("makes no definite claim about the AI provider's retention or training", () => {
        expect(text).toContain("نمی‌توانیم چیزی را قطعی تأیید کنیم")
    })

    it("names the kinds of outside services a user needs to know about", () => {
        for (const service of [
            "سرویس پردازش هوش مصنوعی",
            "سرویس ارسال ایمیل",
            "درگاه پرداخت",
            "سرویس بررسی امنیتی ورود",
            "خدمات ارسال اعلان",
            "زیرساخت میزبانی",
        ]) {
            expect(text.includes(service), `نوع خدمت ${service} نام برده نشده`).toBe(true)
        }
    })

    it("states plainly that card details are never received or stored", () => {
        expect(text).toContain("اطلاعات کارت بانکی")
        expect(text).toContain("دریافت یا ذخیره نمی‌شود")
        expect(text).toContain("وضعیت پرداخت")
    })

    it("covers what is stored on the user's own device, without a wrong promise", () => {
        expect(text).toContain("روی دستگاه و مرورگر خودتان")
        expect(text).toContain("به‌صورت خودکار حذف یا منقضی شوند")
        // جمله‌ی نادرستی که نباید باشد
        expect(text.includes("تا وقتی که خودتان پاکشان نکنید")).toBe(false)
        // و صریحاً بگوید خروج از حساب همه چیز را پاک نمی‌کند
        expect(text).toContain("با خروج از حساب")
    })

    it("describes security in plain language", () => {
        for (const phrase of [
            "قابل بازگردانی",
            "کد تأیید",
            "کوکی امن",
            "بررسی می‌شوند",
            "محدود شده است",
            "پاسخ خام سرویس هوش مصنوعی ذخیره نمی‌شود",
        ]) {
            expect(text.includes(phrase), phrase).toBe(true)
        }
        expect(text).toContain("کاملاً بدون خطر امنیتی نیست")
    })

    it("keeps the last-updated date", () => {
        expect(LAST_UPDATED.trim().length).toBeGreaterThan(0)
    })
})

describe("Settings privacy text — هماهنگ با صفحه‌ی /privacy", () => {
    it("has paragraphs and no leftover wrong claims", () => {
        expect(SETTINGS_PRIVACY_PARAGRAPHS.length).toBeGreaterThan(0)
        const text = SETTINGS_PRIVACY_PARAGRAPHS.join("\n")
        // ادعای غلطِ نسخه‌ی قبلی که در کد هم پشتوانه نداشت
        expect(text.includes("هرگز به اشخاص ثالث")).toBe(false)
        // و به سرور ارسال نمی‌شود (درست نبود: یادآور روزانه روی سرور است)
        expect(text.includes("به سرور ارسال نمی‌شوند")).toBe(false)
    })

    it("stays plain: no provider name, no jargon", () => {
        const text = SETTINGS_PRIVACY_PARAGRAPHS.join("\n")
        for (const forbidden of ["1xai", ".ir", "API", "localStorage", "OTP", "httpOnly", "Push"]) {
            expect(text.includes(forbidden), forbidden).toBe(false)
        }
    })

    it("covers the five points the short text must make", () => {
        const text = SETTINGS_PRIVACY_PARAGRAPHS.join("\n")
        expect(text).toContain("پردازش می‌شود") // حساب و کارها برای ارائه سرویس
        expect(text).toContain("سرویس‌های بیرونی") // سرویس‌های بیرونی
        expect(text).toContain("پردازش هوش مصنوعی") // AI
        expect(text).toContain("ارسال نمی‌شود") // هویتی ارسال نمی‌شود
        expect(text).toContain("دستگاه و مرورگر") // ذخیره روی دستگاه
    })

    it("leads to the full policy from the settings panel", () => {
        // لینک به متن کامل در خود پنل رندر می‌شود (نه داخل پاراگراف‌ها)،
        // پس وجودش را در همان فایل بررسی می‌کنیم.
        const panel = readFileSync(
            join(process.cwd(), "app/dashboard/settings/SettingsPanel.tsx"),
            "utf8",
        )
        expect(panel).toContain('href="/privacy"')
        expect(panel).toContain("SETTINGS_PRIVACY_PARAGRAPHS")
    })
})

describe("Privacy content — هماهنگی با فوتر", () => {
    it("uses the same support email the Footer links to", () => {
        const footer = readFileSync(
            join(process.cwd(), "app/components/layout/Footer.tsx"),
            "utf8",
        )
        // اگر ایمیل پشتیبانی عوض شود، این تست می‌افتد تا متن سیاست جا نماند
        expect(footer).toContain(`"${SUPPORT_EMAIL}"`)
    })

    it("exposes usable contact links", () => {
        expect(CONTACT_LINKS.length).toBeGreaterThan(0)
        for (const link of CONTACT_LINKS) {
            expect(link.href.startsWith("https://")).toBe(true)
            expect(link.label.trim().length).toBeGreaterThan(0)
        }
    })
})

describe("flattenSection", () => {
    it("joins paragraphs and list items into one readable string", () => {
        const ai = findPrivacySection("ai")
        expect(ai).toBeDefined()
        const flat = flattenSection(ai!)
        expect(flat).toContain("سرویس پردازش هوش مصنوعی")
        expect(flat.length).toBeGreaterThan(100)
    })
})
