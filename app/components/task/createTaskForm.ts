// Task create form — pure contract (بدون React)
// ---------------------------------------------
// منطقِ «آیا فرم اجازهٔ ارسال دارد؟» و «بدنهٔ درخواست چیست؟» از کامپوننت جدا شده
// تا بدون jsdom قابل تست باشد — دقیقاً همان الگوی `planProposalView.ts` در همین
// پوشه. کامپوننت فقط این توابع را صدا می‌زند.
//
// قاعدهٔ اصلی: دسته **اجباری** است و یا یک preset canonical می‌آید یا یک
// دستهٔ سفارشی (برچسب + آیکنِ عضو allowlist). منطق draft و اعتبارسنجی در
// `categoryForm.ts` زندگی می‌کند و این فایل فقط آن را به قرارداد create وصل
// می‌کند. سرور هم جداگانه همین قاعده را در schema و سرویس اعمال می‌کند، پس UI
// فقط لایهٔ اول است.

import {
    CATEGORY_REQUIRED_MESSAGE,
    TASK_CATEGORIES,
    isTaskCategoryKey,
    normalizeCategorySelection,
    type TaskCategoryKey,
    type TaskCategorySelection,
} from "@/app/lib/categories"
import { EMPTY_CATEGORY_DRAFT, validateCategoryDraft, type CategoryDraft } from "./categoryForm"

export { CATEGORY_REQUIRED_MESSAGE, TASK_CATEGORIES }
export type { TaskCategoryKey }

/** فیلدی که پیام خطا به آن مربوط است — تا UI پیام را جای درست نشان دهد. */
export type CreateFormErrorField = "title" | "category" | "customLabel" | "customIcon"

export type CreateFormResult =
    | { ok: true; category: TaskCategorySelection }
    | { ok: false; message: string; field: CreateFormErrorField }

export const TITLE_TOO_SHORT_MESSAGE = "عنوان باید حداقل ۳ حرف باشد"

/**
 * validateCreateForm — دروازهٔ submit سازگار با امضای قبلی.
 *
 * اگر `draft` داده شود، همان draft (شامل حالت custom) اعتبارسنجی می‌شود.
 * اگر داده نشود، `category` قدیمی به‌صورت یک preset در نظر گرفته می‌شود؛
 * بنابراین فراخوانی دوآرگومانیِ قبلی همچنان کار می‌کند و **هیچ برچسب
 * دلخواهی بدون آیکن از آن راه رد نمی‌شود** (چون draft پیش‌فرض preset است و
 * کلید canonical می‌خواهد).
 */
export function validateCreateForm(
    title: string,
    category: TaskCategoryKey | string | null,
    draft?: CategoryDraft,
): CreateFormResult {
    if (title.trim().length < 3) {
        return { ok: false, message: TITLE_TOO_SHORT_MESSAGE, field: "title" }
    }

    const selection = draft
        ? validateCategoryDraft(draft)
        : validateCategoryDraft(
              isTaskCategoryKey(category)
                  ? { mode: "preset", preset: category, customLabel: "", customIcon: null }
                  : { ...EMPTY_CATEGORY_DRAFT },
          )

    if (!selection.ok) return { ok: false, message: selection.message, field: selection.field }
    return { ok: true, category: selection.selection }
}

/**
 * buildCreateTaskBody — بدنهٔ POST /api/tasks.
 *
 * برای preset دقیقاً سه فیلد (مثل قبل) و **بدون** `categoryIcon` تا قرارداد
 * قدیمی و allowlist تست‌های موجود دست‌نخورده بماند. برای custom چهار فیلده با
 * آیکن. `dayKey` هرگز از کلاینت نمی‌آید.
 */
export function buildCreateTaskBody(
    title: string,
    scheduledDateIso: string,
    category: TaskCategoryKey | string,
    categoryIcon?: string | null,
) {
    const selection = normalizeCategorySelection(category, categoryIcon)
    return {
        title: title.trim(),
        scheduledDate: scheduledDateIso,
        category: selection?.category ?? String(category),
        ...(selection?.categoryIcon ? { categoryIcon: selection.categoryIcon } : {}),
    }
}
