// C7 — AI source identifiability (§7.13: «Mock از AI واقعی جدا قابل تشخیص است»)
// §9.5: «Mock Result باید در UI قابل تشخیص باشد و با source = "mock" از Real AI Result متمایز شود»
// این نگاشتِ نمایشیِ source → پیام فارسی است؛ منطق دامنه نیست و به HTTP/UI وابسته نیست.

export type AiSourceNotice = string | null

/** «1xai» → تحلیل واقعی؛ «mock» → هشدار پیش‌فرض؛ مقدار ناشناخته → null (بدون پیام) */
export function aiSourceNotice(source: string | null | undefined): AiSourceNotice {
    if (source === "mock") {
        return "⚠️ کلید API موجود نیست؛ نتیجه از تحلیل پیش‌فرض است."
    }
    if (source === "1xai") {
        return "منبع: تحلیل هوش مصنوعی"
    }
    return null
}
