"use client"

import { forwardRef, useCallback, useImperativeHandle, useMemo, useRef, useState } from "react"
import { Turnstile, type TurnstileInstance } from "@marsidev/react-turnstile"
import { useSettings } from "@/app/contexts/SettingsContext"

/**
 * ویجت مشترک کپچا (Cloudflare Turnstile) برای همه‌ی فرم‌های محافظت‌شده.
 *
 * قرارداد استفاده:
 * - ویجت *قابل مشاهده* است و تا رسیدن توکن معتبر، دکمه‌ی ارسال فرم باید غیرفعال باشد.
 * - والد توکن را از طریق `onTokenChange` می‌گیرد و برای *هر درخواست* جدید باید
 *   `ref.reset()` را صدا بزند: توکن‌های Turnstile یک‌بارمصرف‌اند و پس از مصرف،
 *   انقضا یا خطای درخواست باید توکن قبلی پاک و ویجت دوباره چالش بگیرد.
 * - حالت‌های loading / ready / success / expired / error مدیریت و به فارسی نمایش
 *   داده می‌شوند و در حالت خطا/انقضا دکمه‌ی «تلاش مجدد» ارائه می‌شود.
 */

export type CaptchaWidgetHandle = {
    /** توکن فعلی (null یعنی هنوز آماده/معتبر نیست). */
    getToken: () => string | null
    /** پاک کردن توکن و گرفتن چالش تازه از Turnstile. */
    reset: () => void
}

type CaptchaStatus = "loading" | "ready" | "success" | "expired" | "error"

type CaptchaWidgetProps = {
    /** action این فرم؛ از CAPTCHA_ACTIONS استفاده کن (سرور همان را انتظار دارد). */
    action: string
    /** با هر تغییر توکن (گرفتن/پاک شدن) صدا زده می‌شود. */
    onTokenChange?: (token: string | null) => void
    className?: string
}

const STATUS_MESSAGES: Record<CaptchaStatus, string> = {
    loading: "در حال بارگذاری تأیید امنیتی…",
    ready: "برای ادامه، تأیید امنیتی بالا را کامل کن",
    success: "تأیید امنیتی انجام شد",
    expired: "زمان تأیید امنیتی به پایان رسید؛ لطفاً دوباره تأیید کن",
    error: "تأیید امنیتی بارگذاری نشد؛ دوباره تلاش کن",
}

const CaptchaWidget = forwardRef<CaptchaWidgetHandle, CaptchaWidgetProps>(function CaptchaWidget(
    { action, onTokenChange, className },
    ref,
) {
    const siteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? ""
    const { settings } = useSettings()

    const widgetRef = useRef<TurnstileInstance | null>(null)
    const tokenRef = useRef<string | null>(null)
    const [status, setStatus] = useState<CaptchaStatus>(siteKey ? "loading" : "error")

    const applyToken = useCallback(
        (token: string | null) => {
            tokenRef.current = token
            onTokenChange?.(token)
        },
        [onTokenChange],
    )

    const reset = useCallback(() => {
        applyToken(null)
        setStatus(siteKey ? "loading" : "error")
        widgetRef.current?.reset()
    }, [applyToken, siteKey])

    useImperativeHandle(
        ref,
        () => ({
            getToken: () => tokenRef.current,
            reset,
        }),
        [reset],
    )

    // همراستا کردن تم ویجت با تم انتخاب‌شده‌ی برنامه (system → auto)
    const widgetTheme = useMemo(
        () =>
            settings.theme === "dark" || settings.theme === "light"
                ? settings.theme
                : "auto",
        [settings.theme],
    )

    const rootClass = className ? `dp-field ${className}` : "dp-field"

    if (!siteKey) {
        return (
            <div className={rootClass}>
                <p className="dp-error-text" role="alert">
                    کلید کپچا تنظیم نشده است؛ ارسال فرم تا پیکربندی کلید غیرفعال است.
                </p>
            </div>
        )
    }

    const showRetry = status === "error" || status === "expired"

    return (
        <div className={rootClass}>
            <Turnstile
                ref={widgetRef}
                siteKey={siteKey}
                options={{
                    action,
                    theme: widgetTheme,
                    language: "fa",
                    size: "flexible",
                }}
                onWidgetLoad={() => setStatus((current) => (current === "error" ? current : "ready"))}
                onSuccess={(token) => {
                    applyToken(token)
                    setStatus("success")
                }}
                onExpire={() => {
                    applyToken(null)
                    setStatus("expired")
                }}
                onTimeout={() => {
                    applyToken(null)
                    setStatus("error")
                }}
                onError={() => {
                    applyToken(null)
                    setStatus("error")
                }}
            />

            <p
                className={status === "error" || status === "expired" ? "dp-error-text" : "dp-card-hint"}
                role="status"
                aria-live="polite"
            >
                {STATUS_MESSAGES[status]}
            </p>

            {showRetry && (
                <button type="button" className="dp-btn dp-btn-ghost" onClick={reset}>
                    تلاش مجدد تأیید امنیتی
                </button>
            )}
        </div>
    )
})

export default CaptchaWidget
