import { getTaskCategory, isTaskCategoryKey, resolveCategoryDisplay } from "@/app/lib/categories"

export type TaskPriority = "HIGH" | "MEDIUM" | "LOW"
export type TaskStatus = "TODO" | "IN_PROGRESS" | "DONE"

export type TaskItem = {
    id: number
    title: string
    category: string | null
    /**
     * فقط برای دستهٔ سفارشی؛ presetها آیکن‌شان را از واژگان canonical می‌گیرند
     * و اینجا null می‌ماند. اختیاری است تا دادهٔ كش‌شده/legacy که این فیلد را
     * ندارد همچنان معتبر بماند.
     */
    categoryIcon?: string | null
    priority: TaskPriority | null // null = تسک هنوز تحلیل نشده (G-16)
    score: number | null
    reason: string | null
    status: TaskStatus
    dayKey: string
    estimatedTime: number | null
    allocatedMinutes: number | null
    spentMinutes: number | null
    completedOn: string | null
    createdAt: string
    updatedAt: string
}

export const priorityMeta: Record<TaskPriority, { label: string; color: string; bg: string }> = {
    HIGH: { label: "بالا", color: "#b42318", bg: "#fee4e2" },
    MEDIUM: { label: "متوسط", color: "#b54708", bg: "#fef0c7" },
    LOW: { label: "کم", color: "#175cd3", bg: "#eff8ff" },
}

// نمایش اولویتِ تحلیلنشده — همون توکنهای خنثای «بدون دسته»
export const priorityMissingMeta: { label: string; color: string; bg: string } = {
    label: "—",
    color: "#475467",
    bg: "#f2f4f7",
}

/**
 * رنگ هر دسته — **جدا از واژگان** و عمداً فقط توکن‌های ظاهری.
 *
 * واژگان (key/label/icon) از `app/lib/categories` می‌آید؛ اینجا فقط رنگ است تا
 * `categoryInfo` بتواند خروجیِ رنگیِ کامل بدهد بدون آنکه فهرست دومی از
 * دسته‌ها ساخته شود. کلیدها محدود به `TaskCategoryKey` است، پس TypeScript خودش
 * تضمین می‌کند هر دستهٔ canonical رنگ دارد.
 */
const categoryColor: Record<
    import("@/app/lib/categories").TaskCategoryKey,
    { color: string; bg: string }
> = {
    home: { color: "#b54708", bg: "#fef0c7" },
    work: { color: "#175cd3", bg: "#eff8ff" },
    transport: { color: "#6941c6", bg: "#f4f3ff" },
    shopping: { color: "#067647", bg: "#ecfdf3" },
    learning: { color: "#175cd3", bg: "#eff8ff" },
    health: { color: "#b42318", bg: "#fee4e2" },
    leisure: { color: "#c11574", bg: "#fdf2fa" },
    personal: { color: "#475467", bg: "#f2f4f7" },
}

// fallback خنثی برای دادهٔ legacy/ناشناخته — UI هرگز crash نمی‌کند و رشتهٔ خام
// را به کاربر نشان می‌دهد تا بتواند آن را اصلاح کند.
const categoryFallback = { color: "#475467", bg: "#f2f4f7" }

/**
 * categoryInfo — تنها نقطهٔ نمایش دسته در UI.
 *
 * رنگ و برچسب از واژگان canonical مشتق می‌شوند (هیچ نگاشت دومی وجود ندارد) و
 * آیکن از `resolveCategoryDisplay` می‌آید: preset آیکن واژگان را می‌گیرد و
 * custom آیکن ذخیره‌شده را — یا اگر خالی/خراب بود یک fallback امن.
 *
 * برای مقادیر legacy (مثلاً «Work» یا «Urgent» از قبل ذخیره‌شده) یا هر رشتهٔ
 * ناشناخته، به fallback خنثی برمی‌گردد — بدون حذف داده و بدون crash.
 */
export function categoryInfo(category: string | null, categoryIcon?: string | null): {
    label: string
    icon: string
    color: string
    bg: string
} {
    const display = resolveCategoryDisplay(category, categoryIcon)
    if (!category) return { ...display, ...categoryFallback }
    if (isTaskCategoryKey(category)) {
        const meta = getTaskCategory(category)!
        return { label: meta.label, icon: meta.icon, ...categoryColor[category] }
    }
    // custom (یا legacy) — رنگ خنثی، اما برچسب و آیکن واقعی خودش
    return { ...display, ...categoryFallback }
}
