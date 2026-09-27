"use client"

import { useId } from "react"
import { TASK_CATEGORIES } from "@/app/lib/categories"
import {
    CUSTOM_CATEGORY_ICONS,
    CUSTOM_LABEL_PLACEHOLDER,
    EMPTY_CATEGORY_DRAFT,
    OTHER_CATEGORY_ICON,
    OTHER_CATEGORY_LABEL,
    selectCustom,
    selectPreset,
    type CategoryDraft,
} from "./categoryForm"
import styles from "./task.module.css"

/**
 * CategoryPicker — انتخاب دستهٔ تسک، مشترک بین Create و Edit.
 *
 * دو حالت دارد و فقط یکی در هر لحظه فعال است:
 *  - preset: هشت چیپ canonical از `app/lib/categories` (منبع واحد آیکن‌ها)
 *  - custom: یک input نام + یک شبکهٔ آیکن از allowlist ثابت
 *
 * این کامپوننت هیچ قانونی ندارد: وضعیت `draft` را از بیرون می‌گیرد و
 * `onChange` می‌دهد. اعتبارسنجی در `validateCategoryDraft` (pure) است تا بدون
 * jsdom قابل تست بماند.
 *
 * دسترس‌پذیری: هر دو گروه `role="radiogroup"` با `aria-checked`، و خطاها با
 * `role="alert"` اعلام می‌شوند. همه‌ی کنترل‌ها button/input واقعی‌اند تا
 * با Tab و کلید جهت‌ها کار کنند.
 */
type Props = {
    value: CategoryDraft
    onChange: (draft: CategoryDraft) => void
    /** پیام خطای مربوط به خودِ دسته (نه فیلدهای custom) */
    error?: string | null
    /** پیام خطای فیلد نام custom */
    customLabelError?: string | null
    /** پیام خطای فیلد آیکن custom */
    customIconError?: string | null
    disabled?: boolean
}

export default function CategoryPicker({
    value,
    onChange,
    error,
    customLabelError,
    customIconError,
    disabled,
}: Props) {
    const uid = useId()
    const labelId = `${uid}-label`
    const customLabelId = `${uid}-custom-label`
    const customIconLegendId = `${uid}-custom-icon`
    const isCustom = value.mode === "custom"

    return (
        <fieldset className={styles.categoryFieldset} disabled={disabled}>
            <legend className={styles.categoryLegend} id={labelId}>
                دسته‌بندی *
            </legend>

            <div
                className={styles.categoryGrid}
                role="radiogroup"
                aria-labelledby={labelId}
                aria-label="دسته‌بندی"
            >
                {TASK_CATEGORIES.map((cat) => {
                    const selected = !isCustom && value.preset === cat.key
                    return (
                        <button
                            type="button"
                            key={cat.key}
                            role="radio"
                            aria-checked={selected}
                            className={`${styles.categoryChip} ${selected ? styles.categoryChipSelected : ""}`}
                            onClick={() => onChange(selectPreset(cat.key))}
                        >
                            <span aria-hidden="true">{cat.icon}</span>
                            <span>{cat.label}</span>
                        </button>
                    )
                })}

                {/* «دسته‌بندی دیگر» — دروازهٔ ورود به حالت custom */}
                <button
                    type="button"
                    role="radio"
                    aria-checked={isCustom}
                    aria-controls={`${uid}-custom`}
                    className={`${styles.categoryChip} ${isCustom ? styles.categoryChipSelected : ""}`}
                    onClick={() => onChange(selectCustom(value))}
                >
                    <span aria-hidden="true">{OTHER_CATEGORY_ICON}</span>
                    <span>{OTHER_CATEGORY_LABEL}</span>
                </button>
            </div>

            {error && (
                <p className={styles.categoryError} role="alert">
                    {error}
                </p>
            )}

            {isCustom && (
                <div className={styles.customCategory} id={`${uid}-custom`}>
                    <label className={styles.customFieldLabel} htmlFor={customLabelId}>
                        نام دسته‌بندی
                    </label>
                    <input
                        id={customLabelId}
                        className={styles.input}
                        placeholder={CUSTOM_LABEL_PLACEHOLDER}
                        value={value.customLabel}
                        maxLength={60} // سقف نرم UI؛ سقف سخت‌افزاری ۵۰ است و در pure layer اعمال می‌شود
                        onChange={(e) =>
                            onChange({ ...value, customLabel: e.target.value })
                        }
                    />
                    {customLabelError && (
                        <p className={styles.categoryError} role="alert">
                            {customLabelError}
                        </p>
                    )}

                    <span className={styles.customFieldLabel} id={customIconLegendId}>
                        انتخاب آیکن
                    </span>
                    <div
                        className={styles.iconGrid}
                        role="radiogroup"
                        aria-labelledby={customIconLegendId}
                        aria-label="انتخاب آیکن"
                    >
                        {CUSTOM_CATEGORY_ICONS.map((icon) => {
                            const selected = value.customIcon === icon
                            return (
                                <button
                                    type="button"
                                    key={icon}
                                    role="radio"
                                    aria-checked={selected}
                                    aria-label={`آیکن ${icon}`}
                                    className={`${styles.iconChip} ${selected ? styles.iconChipSelected : ""}`}
                                    onClick={() => onChange({ ...value, customIcon: icon })}
                                >
                                    <span aria-hidden="true">{icon}</span>
                                </button>
                            )
                        })}
                    </div>
                    {customIconError && (
                        <p className={styles.categoryError} role="alert">
                            {customIconError}
                        </p>
                    )}
                </div>
            )}
        </fieldset>
    )
}

export { EMPTY_CATEGORY_DRAFT }
