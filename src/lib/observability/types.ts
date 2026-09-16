// فاز صفر Observability — تایپ‌های مشترک
// فقط تایپ؛ هیچ وابستگی خارجی یا runtime logic ندارد (محدودیت سند فاز صفر).

/** زمینه‌ی مشاهدت‌پذیری هر درخواست؛ سمت سرور ساخته (context.ts) و به لایه‌های پایین‌تر پاس داده می‌شود. */
export interface ObservabilityContext {
    /** شناسه‌ی یکتای درخواست — حتماً سمت سرور با crypto.randomUUID() تولید می‌شود. */
    requestId: string
    /** مسیر/نام endpoint (مثلاً "POST /api/tasks"). */
    endpoint: string
    /** شناسه‌ی کاربر احرازهویت‌شده؛ اختیاری — پس از auth توسط caller ست می‌شود: context.userId = user.id */
    userId?: number
    /** نام فیچر/دامنه برای فیلترکردن لاگ‌ها (مثلاً "planner" یا "tasks"). */
    feature?: string
}

/** دسته‌بندی خطا برای گروه‌بندی/فیلتر در لاگ‌ها. */
export type ErrorCategory =
    | "VALIDATION"
    | "AUTHENTICATION"
    | "AUTHORIZATION"
    | "NOT_FOUND"
    | "CONFLICT"
    | "RATE_LIMIT"
    | "DATABASE"
    | "EXTERNAL_SERVICE"
    | "BUSINESS_RULE"
    | "INTERNAL"
    | "UNKNOWN"

/** شدت خطا. */
export type ErrorSeverity = "INFO" | "WARNING" | "ERROR" | "CRITICAL"
