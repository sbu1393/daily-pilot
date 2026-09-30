"use client"

import type { CSSProperties } from "react"

/**
 * دکمهٔ چشم (نمایش/مخفی کردن رمز) برای فیلدهای رمز.
 *
 * چون قبلاً فقط داخل `FormInput` به‌صورت inline نوشته شده بود، هر فیلد رمز
 * دیگری (مثل مودال «تعیین رمز جدید») ناچار بود همان markup را تکرار کند.
 * این کامپوننت همان ظاهر و همان رفتار را نگه می‌دارد و در هر دو جا استفاده
 * می‌شود تا UI پروژه یکدست بماند — بدون هیچ dependency جدید (آیکون inline SVG).
 *
 * دسترس‌پذیری:
 *   • `aria-label` پویا است («نمایش رمز عبور» / «مخفی کردن رمز عبور»)،
 *   • `aria-pressed` وضعیت toggle را به صفحه‌خوان اعلام می‌کند،
 *   • `type="button"` تا فرم را submit نکند.
 */
type Props = {
    /** آیا رمز در حال حاضر نمایش داده می‌شود؟ */
    visible: boolean
    onToggle: () => void
    /**
     * برچسب دسترس‌پذیری؛ پیش‌فرض بر اساس وضعیت فعلی ساخته می‌شود.
     * برای فیلدهایی که برچسب خاص دارند (مثل «تکرار رمز عبور جدید») قابل override.
     */
    label?: string
    /** `-1` یعنی از ترتیب Tab کنار گذاشته شود (رفتار قدیمی فرم ورود). */
    tabIndex?: number
}

const buttonStyle: CSSProperties = {
    position: "absolute",
    left: "0.6rem",
    background: "transparent",
    border: "none",
    cursor: "pointer",
    padding: "4px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "var(--text-muted, #94a3b8)",
}

export default function PasswordVisibilityToggle({
    visible,
    onToggle,
    label,
    tabIndex,
}: Props) {
    return (
        <button
            type="button"
            onClick={onToggle}
            tabIndex={tabIndex}
            aria-pressed={visible}
            aria-label={label ?? (visible ? "مخفی کردن رمز عبور" : "نمایش رمز عبور")}
            style={buttonStyle}
        >
            {visible ? (
                // آیکون چشم بسته (مخفی کردن)
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                    <line x1="1" y1="1" x2="23" y2="23" />
                </svg>
            ) : (
                // آیکون چشم باز (نمایش)
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                    <circle cx="12" cy="12" r="3" />
                </svg>
            )}
        </button>
    )
}
