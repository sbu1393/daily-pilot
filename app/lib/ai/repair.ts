// ابزارهای مقاوم‌سازی خروجی مدل: استخراج JSON، تعمیر سبک و نرمال‌سازی اعداد

import { TASK_CATEGORY_KEYS, type TaskCategoryKey } from "@/app/lib/categories"

/**
 * fallback دسته در زمان تحلیل: اگر مدل کلید معتبر ندهد، «شخصی» (عمومی‌ترین و
 * بی‌خطرترین انتخاب) استفاده می‌شود. این فقط پیشنهاد AI است و هرگز دستهٔ
 * انتخابی کاربر را بازنویسی نمی‌کند.
 */
const AI_DEFAULT_CATEGORY: TaskCategoryKey = "personal"

/** حذف BOM / فاصله‌های نیم‌فاصله و نرمال‌سازی کوتیشن‌های یونیکد */
export function cleanRaw(raw: string): string {
    return raw
        .replace(/^\uFEFF/, "")
        .replace(/\u00A0/g, " ")
        .replace(/[\u201C\u201D]/g, '"') // “ ” → "
        .replace(/[\u2018\u2019]/g, "'") // ‘ ’ → '
        .trim()
}

/** استخراج اولین آبجکت JSON از متن مدل (با تحمل markdown و متن اضافه) */
export function extractJson(raw: string): string {
    const cleaned = cleanRaw(raw).replace(/```(?:json)?/gi, "").trim()

    const start = cleaned.indexOf("{")
    const end = cleaned.lastIndexOf("}")
    if (start === -1 || end === -1 || end <= start) {
        throw new Error("JSON object not found in model output")
    }

    // کامای اضافه قبل از بستن آبجکت/آرایه — خطای بسیار رایج مدل‌ها
    return cleaned.slice(start, end + 1).replace(/,\s*([}\]])/g, "$1")
}

type RawAnalysis = {
    priority: "HIGH" | "MEDIUM" | "LOW"
    score: number
    estimatedMinutes: number
    reason: string
    category: string
}

// واژگان از دسته‌بندی canonical می‌آید تا repair و schema و UI هرگز جدا نیفتند.
// `Urgent` دیگر دسته‌بندی نیست (فوریت = priority).
const CATEGORIES = TASK_CATEGORY_KEYS

/** نرمال‌سازی: اعداد را محدود و صحیح کن، رشته‌ها را تمیز کن (قبل از zod) */
export function normalizeAnalysis(raw: unknown): RawAnalysis {
    const obj = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>

    const toIntClamped = (v: unknown, min: number, max: number, fallback: number): number => {
        const n = Number(v)
        if (!Number.isFinite(n)) return fallback
        return Math.round(Math.min(max, Math.max(min, n)))
    }

    const toCleanString = (v: unknown, fallback: string, maxLen: number): string => {
        if (typeof v !== "string") return fallback
        const s = v.trim()
        return s ? s.slice(0, maxLen) : fallback
    }

    const priority = toCleanString(obj.priority, "MEDIUM", 10).toUpperCase()
    // مدل ممکن است کلید قدیمی («Work») یا کلید ناشناخته بدهد؛ هر چیز خارج از
    // واژگان canonical به «شخصی» نگاشت می‌شود (fallback بی‌خطر، هرگز throw نمی‌کند).
    const rawCategory = toCleanString(obj.category, AI_DEFAULT_CATEGORY, 30).trim()
    // نرمال‌سازی حروف بزرگ/کوچک تا «Work» و «work» یکی دیده شوند
    const category = rawCategory.toLowerCase()

    return {
        priority: priority === "HIGH" || priority === "LOW" ? priority : "MEDIUM",
        score: toIntClamped(obj.score, 0, 100, 50),
        estimatedMinutes: toIntClamped(obj.estimatedMinutes, 5, 480, 30),
        reason: toCleanString(obj.reason, "بدون توضیح", 300),
        category: (CATEGORIES as readonly string[]).includes(category) ? category : AI_DEFAULT_CATEGORY,
    }
}

/** خروجی خام مدل → آبجکت نرمال‌شده (اگه اصلاً JSON نباشه خطا می‌ده) */
export function parseAiJson(raw: string): RawAnalysis {
    return normalizeAnalysis(JSON.parse(extractJson(raw)))
}
