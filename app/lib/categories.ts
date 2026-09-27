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

// ── دستهٔ سفارشی (Custom) ────────────────────────────────────────────────────
// preset و custom از نظر semantics جدا می‌مانند: preset یک **کلید** canonical
// است و custom یک **برچسب آزادِ کاربر**. ذخیره‌سازی هر دو در همان ستون String
// انجام می‌شود، پس برای تشخیص، `isTaskCategoryKey` تنها مرجع است — نه حدس زدن
// از روی شکل رشته.
//
// icon برای preset **هرگز** ذخیره نمی‌شود (`categoryIcon = null`) تا تغییر آیکن
// presetها هیچ migration داده‌ای لازم نداشته باشد؛ آیکن از همین فایل resolve
// می‌شود. برای custom، آیکن از یک allowlist ثابت انتخاب و ذخیره می‌شود، چون
// کاربر نباید هر رشتهٔ دلخواهی را به API بفرستد.

/** آیکن‌های مجاز دستهٔ سفارشی — allowlist ثابت و کوچک (single source of truth). */
export const CUSTOM_CATEGORY_ICONS = [
    "🏷️",
    "🚀",
    "🎯",
    "💡",
    "📌",
    "🛠️",
    "⭐",
    "💰",
    "🎨",
    "💻",
    "📱",
    "📦",
    "✈️",
    "🎵",
    "📖",
    "☕",
] as const

export type CustomCategoryIcon = (typeof CUSTOM_CATEGORY_ICONS)[number]

/** آیکن نمایشی وقتی custom بدون آیکن معتبر ذخیره شده یا آیکنش خراب است. */
export const CUSTOM_CATEGORY_FALLBACK_ICON = "🏷️"

/** محدودیت طول برچسب custom — با conventions عنوان (۳..۲۰۰) هماهنگ و کوتاه‌تر. */
export const CUSTOM_CATEGORY_MIN_LENGTH = 2
export const CUSTOM_CATEGORY_MAX_LENGTH = 50

export const CUSTOM_CATEGORY_LABEL_MESSAGE = `نام دسته‌بندی باید بین ${CUSTOM_CATEGORY_MIN_LENGTH} تا ${CUSTOM_CATEGORY_MAX_LENGTH} حرف باشد`
export const CUSTOM_CATEGORY_ICON_REQUIRED_MESSAGE = "برای دسته‌بندی سفارشی یک آیکن انتخاب کن"
export const CUSTOM_CATEGORY_ICON_INVALID_MESSAGE = "آیکن انتخاب‌شده معتبر نیست"
export const CUSTOM_CATEGORY_RESERVED_MESSAGE =
    "این نام با یکی از دسته‌بندی‌های پیش‌فرض یکسان است؛ همان دسته را انتخاب کن"
export const CUSTOM_CATEGORY_MARKUP_MESSAGE = "نام دسته‌بندی نمی‌تواند شامل کاراکترهای <> باشد"
export const PRESET_ICON_FORBIDDEN_MESSAGE =
    "برای دسته‌بندی‌های پیش‌فرض آیکن جداگانه فرستاده نمی‌شود"
export const CATEGORY_ICON_WITHOUT_CATEGORY_MESSAGE =
    "برای تعیین آیکن باید دسته‌بندی هم ارسال شود"

/**
 * isCustomCategoryIcon — گارد نوعی allowlist آیکن، برای مرزهای غیرقابل‌اعتماد.
 * هرگز throw نمی‌کند.
 */
export function isCustomCategoryIcon(value: unknown): value is CustomCategoryIcon {
    return (
        typeof value === "string" &&
        (CUSTOM_CATEGORY_ICONS as readonly string[]).includes(value)
    )
}

/**
 * isCustomCategoryLabel — آیا این رشته یک برچسب custom معتبر است؟
 *
 * قواعد (همان‌هایی که در schema و سرویس enforce می‌شوند):
 *  - غایب/خالی/فقط فاصله → false
 *  - طول بین ۲ تا ۵۰ (کاراکتر، نه بایت)
 *  - بدون `<` یا `>` — markup پذیرفته نمی‌شود (React خودش escape می‌کند، ولی
 *    این فیلد در لایهٔ داده هم نباید HTML به نظر برسد)
 *  - نباید با یک کلید canonical یکسان باشد (case-insensitive): فضای‌نام کلید
 *    preset و برچسب custom هرگز نبایدOverlap کند، وگرنه تشخیص preset/custom
 *    مبهم می‌شود.
 *
 * trim **قبل** از اندازه‌گیری انجام می‌شود تا «  کار  » مثل «کار» باشد.
 */
export function isCustomCategoryLabel(value: unknown): value is string {
    if (typeof value !== "string") return false
    const trimmed = value.trim()
    if (trimmed.length < CUSTOM_CATEGORY_MIN_LENGTH) return false
    if (trimmed.length > CUSTOM_CATEGORY_MAX_LENGTH) return false
    if (trimmed.includes("<") || trimmed.includes(">")) return false
    const lower = trimmed.toLowerCase()
    if ((TASK_CATEGORY_KEYS as readonly string[]).some((k) => k.toLowerCase() === lower)) {
        return false
    }
    return true
}

/**
 * classifyCategory — تنها نقطهٔ تصمیم «preset است یا custom».
 * ورودی ناشناخته (legacy مثل "Work" یا null) برمی‌گردد، پس هیچ‌جایی در UI
 * مجبور به تکرار این منطق نیست.
 */
export function classifyCategory(value: unknown): "preset" | "custom" | "none" {
    if (isTaskCategoryKey(value)) return "preset"
    if (isCustomCategoryLabel(value)) return "custom"
    return "none"
}

/**
 * یک انتخاب دسته — شکل ذخیره‌شده در Task.
 * preset  → `categoryIcon` همیشه null
 * custom  → `categoryIcon` همیشه یکی از allowlist
 */
export type TaskCategorySelection = {
    category: string
    categoryIcon: CustomCategoryIcon | null
}

/**
 * normalizeCategorySelection — نرمال‌سازی + اعتبارسنجی یک جفت (category, icon).
 *
 * تنها مرجع backend: schema (HTTP) و سرویس هر دو همین تابع را صدا می‌زنند، پس
 * «قانون» فقط یک پیاده‌سازی دارد. ورودی نامعتبر `null` برمی‌گرداند و هرگز
 * throw نمی‌کند.
 */
export function normalizeCategorySelection(
    category: unknown,
    categoryIcon: unknown,
): TaskCategorySelection | null {
    if (isTaskCategoryKey(category)) {
        // preset: آیکن ذخیره نمی‌شود. آیکن ارسالی نادیده گرفته می‌شود، چون
        // schema لایهٔ بالاتر آن را رد می‌کند و اینجا فقط canonicalize می‌شود.
        return { category, categoryIcon: null }
    }
    if (isCustomCategoryLabel(category) && isCustomCategoryIcon(categoryIcon)) {
        return { category: category.trim(), categoryIcon }
    }
    return null
}

/**
 * assertCategorySelection — نسخهٔ fail-fast سرویس (هم‌خانوادهٔ
 * assertTaskCategoryKey). prefix خطا عمداً همان `INVALID_TASK_CATEGORY` است تا
 * هر guard/تستی که روی رفتار قبلی تکیه کرده همچنان معتبر بماند.
 */
export function assertCategorySelection(
    category: unknown,
    categoryIcon?: unknown,
): asserts category is string {
    if (!normalizeCategorySelection(category, categoryIcon)) {
        throw new Error(
            `INVALID_TASK_CATEGORY: ${String(category)}/${String(categoryIcon)} — outside the canonical vocabulary or an invalid custom pair`,
        )
    }
}

/**
 * resolveCategoryDisplay — تنها نقطهٔ resolve آیکن برای نمایش.
 *
 * - preset  → آیکن از همین فایل (`: null` ذخیره می‌شود و نادیده گرفته می‌شود)
 * - custom  → آیکن ذخیره‌شده، و اگر خالی/خارج از allowlist بود fallback امن
 * - legacy  → رشتهٔ خام + آیکن fallback خنثی
 */
export function resolveCategoryDisplay(
    category: string | null | undefined,
    categoryIcon?: string | null,
): { label: string; icon: string } {
    if (!category) return { label: "بدون دسته", icon: "" }
    if (isTaskCategoryKey(category)) {
        const meta = getTaskCategory(category)!
        return { label: meta.label, icon: meta.icon }
    }
    return {
        label: category,
        icon: isCustomCategoryIcon(categoryIcon)
            ? categoryIcon
            : CUSTOM_CATEGORY_FALLBACK_ICON,
    }
}

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
