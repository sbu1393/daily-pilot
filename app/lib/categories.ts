// Task Categories — canonical vocabulary (SINGLE SOURCE OF TRUTH)
// ---------------------------------------------------------------
// هر جای برنامه که به «دسته‌بندی تسک» نیاز دارد باید از همین فایل بخواند:
// UI، schemaهای اعتبارسنجی، لایهٔ AI و نمایش کارت تسک. فهرست دیگری (حتی یک
// آرایهٔ موازی) وجود ندارد؛ وگرنه واژگان‌ها به‌مرور ناهماهنگ می‌شوند.
//
// ── چرا key انگلیسی و ذخیره در ستون String موجود؟ ──────────────────────────────
// `Task.category` از قبل یک ستون `String?` است و در کل پروژه (سرویس، UI، AI،
// رویدادهای محصول، پنل ادم) به‌صورت رشته مصرف می‌شود. افزودن مدل `Category`
// یعنی migration + seed + backfillِ داده‌های legacy — و چون
// «دسته‌بندی برای تسک‌های جدید اجباری است» یک **قاعدهٔ مرزِ ایجاد** است، نه
// یک مهاجرت داده، اعمال آن در لایهٔ اپلیکیشن هم دقیق‌تر است و هم غیرمخرب.
//
// در نتیجه:
//   - ستون DB همچنان nullable است تا داده‌های legacy از بین نروند (§12/§13).
//   - قیدِ «همیشه یک دستهٔ معتبر» در **مرز create** اعمال می‌شود: schema + سرویس.
//   - مقدار ذخیره‌شده همیشه یک `TaskCategoryKey` از همین فایل است.
//
// ── چرا `Urgent` دسته‌بندی نیست؟ ────────────────────────────────────────────────
// فوریت/اولویت مفهوم جداگانه‌ای است (`Task.priority` + `Task.score`). در واژگان
// قبلیِ ۴تایی، `Urgent` عملاً تکرارِ `priority: HIGH` بود و همین باعث می‌شد کاربر
// «فوری بودن» را به‌جای ماهیت کار انتخاب کند. اینجا فوریت فقط از مسیر اولویت
// می‌آید و دسته‌بندی فقط **موضوع کار** را توصیف می‌کند.

/** یک دستهٔ canonical — همهٔ فیلدهای لازم برای UI و اعتبارسنجی در همین یک رکورد. */
export type TaskCategory = {
    /** کلید پایدار و انگلیسی — همین مقدار در `Task.category` ذخیره می‌شود. */
    key: TaskCategoryKey
    /** برچسب فارسی برای نمایش */
    label: string
    /** ایموجی نمایشی */
    icon: string
    /** ترتیب نمایش در UI (ascending) */
    sortOrder: number
}

/** واژگان رسمی — ترتیب این آرایه، ترتیب نمایش در UI است. */
export const TASK_CATEGORIES = [
    { key: "home", label: "خانه", icon: "🏠", sortOrder: 1 },
    { key: "work", label: "کار", icon: "💼", sortOrder: 2 },
    { key: "transport", label: "خودرو و رفت‌وآمد", icon: "🚗", sortOrder: 3 },
    { key: "shopping", label: "خرید و کارهای روزمره", icon: "🛒", sortOrder: 4 },
    { key: "learning", label: "یادگیری", icon: "📚", sortOrder: 5 },
    { key: "health", label: "سلامت و ورزش", icon: "🏃", sortOrder: 6 },
    { key: "leisure", label: "تفریح و سرگرمی", icon: "🎮", sortOrder: 7 },
    { key: "personal", label: "شخصی", icon: "👤", sortOrder: 8 },
] as const satisfies readonly TaskCategory[]

/** کلیدهای معتبر — برای `z.enum` و اعتبارسنجی مرزی. */
export const TASK_CATEGORY_KEYS = [
    "home",
    "work",
    "transport",
    "shopping",
    "learning",
    "health",
    "leisure",
    "personal",
] as const

export type TaskCategoryKey = (typeof TASK_CATEGORY_KEYS)[number]

/** پیام خطای مشترک — یک‌بار تعریف، همه‌جا یکسان. */
export const CATEGORY_REQUIRED_MESSAGE = "انتخاب دسته‌بندی الزامی است"

/**
 * isTaskCategoryKey — گارد نوعی برای مرزهای غیرقابل‌اعتماد (بدنهٔ API، صف
 * آفلاین، خروجی AI). برای ورودی ناشناخته `false` می‌دهد؛ هرگز throw نمی‌کند.
 */
export function isTaskCategoryKey(value: unknown): value is TaskCategoryKey {
    return typeof value === "string" && (TASK_CATEGORY_KEYS as readonly string[]).includes(value)
}

/** lookup — رکورد canonical یک کلید، یا undefined. */
export function getTaskCategory(key: string): TaskCategory | undefined {
    return TASK_CATEGORIES.find((c) => c.key === key)
}

/** ✅ — کلید معتبر است. برای گارد‌های fail-fast در سرویس. */
export function assertTaskCategoryKey(value: unknown): asserts value is TaskCategoryKey {
    if (!isTaskCategoryKey(value)) {
        throw new Error(
            `INVALID_TASK_CATEGORY: ${String(value)} — outside the canonical vocabulary`,
        )
    }
}
