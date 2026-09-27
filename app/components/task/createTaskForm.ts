// Task create form — pure contract (بدون React)
// ---------------------------------------------
// منطقِ «آیا فرم اجازهٔ ارسال دارد؟» و «بدنهٔ درخواست چیست؟» از کامپوننت جدا شده
// تا بدون jsdom قابل تست باشد — دقیقاً همان الگوی `planProposalView.ts` در همین
// پوشه. کامپوننت فقط این توابع را صدا می‌زند.
//
// قاعدهٔ اصلی: دستهٔ canonical **اجباری** است. اگر کاربر چیزی انتخاب نکرده باشد
// هیچ درخواستی ساخته نمی‌شود و پیام خطا نشان داده می‌شود. سرور هم جداگانه همین
// قاعده را در schema اعمال می‌کند، پس UI فقط لایهٔ اول است.

import {
    CATEGORY_REQUIRED_MESSAGE,
    TASK_CATEGORIES,
    isTaskCategoryKey,
    type TaskCategoryKey,
} from "@/app/lib/categories"

export { CATEGORY_REQUIRED_MESSAGE, TASK_CATEGORIES }
export type { TaskCategoryKey }

/** نتیجهٔ اعتبارسنجی فرم — پیام خطا یا دستهٔ معتبر. */
export type CreateFormValidation =
    | { ok: true; category: TaskCategoryKey }
    | { ok: false; message: string }

export const TITLE_TOO_SHORT_MESSAGE = "عنوان باید حداقل ۳ حرف باشد"

/**
 * validateCreateForm — تنها دروازهٔ submit.
 *
 * ترتیب بررسی همان چیزی است که کاربر می‌بیند: اول عنوان، بعد دسته. دستهٔ
 * نامعتبر (کلید خارج از واژگان) هم مثل «انتخاب‌نشده» رد می‌شود.
 */
export function validateCreateForm(
    title: string,
    category: TaskCategoryKey | null,
): CreateFormValidation {
    if (title.trim().length < 3) {
        return { ok: false, message: TITLE_TOO_SHORT_MESSAGE }
    }
    if (!isTaskCategoryKey(category)) {
        return { ok: false, message: CATEGORY_REQUIRED_MESSAGE }
    }
    return { ok: true, category }
}

/** بدنهٔ POST /api/tasks — دقیقاً سه فیلد. dayKey هرگز از کلاینت نمی‌آید. */
export function buildCreateTaskBody(
    title: string,
    scheduledDateIso: string,
    category: TaskCategoryKey,
) {
    return {
        title: title.trim(),
        scheduledDate: scheduledDateIso,
        category,
    }
}
