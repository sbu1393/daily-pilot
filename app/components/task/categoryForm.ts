// Task category form — pure contract (بدون React)
// ----------------------------------------------
// انتخاب دستهٔ تسک دو حالت دارد و این فایل تنها جایی است که از «کدام حالت؟
// و آیا معتبر است؟» تصمیم می‌گیرد. UI فقط state این draft را نگه می‌دارد.
//
//  preset → mode="preset"  ، category = کلید canonical ، categoryIcon = null
//  custom → mode="custom"  ، category = برچسب آزاد کاربر ، categoryIcon = عضو allowlist
//
// چرا pure؟ این repo jsdom ندارد (قید صفر وابستگی)، پس منطق فرم مثل
// `planProposalView.ts` به‌صورت توابع خالص تست می‌شود و کامپوننت فقط
// رندر می‌کند. همین فایل برای Create و Edit استفاده می‌شود، پس «قانون» یک‌بار
// نوشته می‌شود.

import {
    CATEGORY_REQUIRED_MESSAGE,
    CUSTOM_CATEGORY_ICON_REQUIRED_MESSAGE,
    CUSTOM_CATEGORY_ICONS,
    CUSTOM_CATEGORY_LABEL_MESSAGE,
    CUSTOM_CATEGORY_MAX_LENGTH,
    CUSTOM_CATEGORY_MIN_LENGTH,
    CUSTOM_CATEGORY_RESERVED_MESSAGE,
    classifyCategory,
    isCustomCategoryIcon,
    isTaskCategoryKey,
    TASK_CATEGORY_KEYS,
    type TaskCategorySelection,
} from "@/app/lib/categories"

/** آیا این برچسب فقط با حروف بزرگ/کوچک با یک کلید canonical یکی است؟ */
function isCanonicalKeySpelling(label: string): boolean {
    const lower = label.trim().toLowerCase()
    return (TASK_CATEGORY_KEYS as readonly string[]).some((k) => k.toLowerCase() === lower)
}

export { CUSTOM_CATEGORY_ICONS }
export type CategoryDraftMode = "preset" | "custom"

/** وضعیت فرم دسته — همان چیزی که UI نگه می‌دارد. */
export type CategoryDraft = {
    mode: CategoryDraftMode
    /** فقط در حالت preset معنا دارد. */
    preset: string | null
    /** فقط در حالت custom معنا دارد؛ کاربر آزاد است هرچه بخواهد تایپ کند. */
    customLabel: string
    /** فقط در حالت custom معنا دارد. */
    customIcon: string | null
}

export const EMPTY_CATEGORY_DRAFT: CategoryDraft = {
    mode: "preset",
    preset: null,
    customLabel: "",
    customIcon: null,
}

export const OTHER_CATEGORY_LABEL = "دسته‌بندی دیگر"
export const OTHER_CATEGORY_ICON = "➕"
export const CUSTOM_LABEL_PLACEHOLDER = "مثلاً: پروژه شخصی"

export type CategoryDraftValidation =
    | { ok: true; selection: TaskCategorySelection }
    | { ok: false; message: string; field: "category" | "customLabel" | "customIcon" }

/**
 * draftFromSelection — حالت اولیهٔ فرم از روی یک Task موجود (یا null).
 *
 * دقیقاً همان چیزی که مودال ویرایش لازم دارد: Task با دستهٔ custom باید در
 * حالت custom باز شود، نامش پر شود و آیکنش انتخاب‌شده دیده شود.
 * دادهٔ legacy (کلید غیرcanonical یا null) هرگز crash نمی‌کند و به custom
 * می‌افتد تا کاربر بتواند آن را اصلاح کند.
 */
export function draftFromSelection(
    category: string | null | undefined,
    categoryIcon?: string | null,
): CategoryDraft {
    if (isTaskCategoryKey(category)) {
        return { mode: "preset", preset: category, customLabel: "", customIcon: null }
    }
    if (classifyCategory(category) === "custom") {
        return {
            mode: "custom",
            preset: null,
            customLabel: category!.trim(),
            // آیکن ذخیره‌شده اگر عضو allowlist باشد؛ وگرنه کاربر خودش انتخاب کند
            customIcon: isCustomCategoryIcon(categoryIcon) ? categoryIcon : null,
        }
    }
    return { ...EMPTY_CATEGORY_DRAFT }
}

/**
 * selectPreset — انتخاب یک دستهٔ پیش‌فرض. ورود به این حالت، مقادیر custom را
 * **پاک** می‌کند تا داده‌ای نامرئی در فرم باقی نماند و بعداً با انتخاب دوبارهٔ
 * custom به‌طور ناخواسته برنگردد.
 */
export function selectPreset(key: string): CategoryDraft {
    if (!isTaskCategoryKey(key)) return { ...EMPTY_CATEGORY_DRAFT }
    return { mode: "preset", preset: key, customLabel: "", customIcon: null }
}

/** رفتن به حالت custom: داده‌های قبلی custom نگه داشته می‌شوند (بازگشت کاربر). */
export function selectCustom(draft?: CategoryDraft): CategoryDraft {
    return {
        mode: "custom",
        preset: null,
        customLabel: draft?.customLabel ?? "",
        customIcon: draft?.customIcon ?? null,
    }
}

/**
 * validateCategoryDraft — تنها دروازهٔ اعتبارسنجی دسته.
 * سرور هم جداگانه همین قاعده را در schema و سرویس اعمال می‌کند، پس UI فقط
 * لایهٔ اول است.
 */
export function validateCategoryDraft(draft: CategoryDraft): CategoryDraftValidation {
    if (draft.mode === "preset") {
        if (!isTaskCategoryKey(draft.preset)) {
            return { ok: false, message: CATEGORY_REQUIRED_MESSAGE, field: "category" }
        }
        // preset: آیکن هرگز ارسال نمی‌شود (در واژگان canonical است)
        return { ok: true, selection: { category: draft.preset, categoryIcon: null } }
    }

    const label = draft.customLabel.trim()
    if (label.length < CUSTOM_CATEGORY_MIN_LENGTH || label.length > CUSTOM_CATEGORY_MAX_LENGTH) {
        return { ok: false, message: CUSTOM_CATEGORY_LABEL_MESSAGE, field: "customLabel" }
    }
    // هم‌پوشانی با یک کلید preset پیام مخصوص خودش را دارد تا کاربر بفهمد
    // «کار» از قبل وجود دارد، نه اینکه فکر کند نامش ایراد دارد.
    if (isTaskCategoryKey(label) || isCanonicalKeySpelling(label)) {
        return { ok: false, message: CUSTOM_CATEGORY_RESERVED_MESSAGE, field: "customLabel" }
    }
    if (!isCustomCategoryIcon(draft.customIcon)) {
        return { ok: false, message: CUSTOM_CATEGORY_ICON_REQUIRED_MESSAGE, field: "customIcon" }
    }
    // قاعدهٔ نهایی از منبع واحد واژگان می‌آید (طول، markup، هم‌پوشانی با preset)
    if (classifyCategory(label) !== "custom") {
        return { ok: false, message: CUSTOM_CATEGORY_LABEL_MESSAGE, field: "customLabel" }
    }
    return { ok: true, selection: { category: label, categoryIcon: draft.customIcon } }
}
