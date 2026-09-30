"use client"

// کد هدیه — ورود کد برای کاربر عادی (AI Quota V2)
//
// - endpoint: POST /api/promo/redeem (فقط کد از کلاینت؛ userId از session).
//   endpoint و منطق backend دست‌نخورده‌اند؛ این کامپوننت فقط از داشبورد به
//   صفحهٔ اشتراک منتقل شده تا داشبورد روی کارهای روزانه متمرکز بماند.
// - الگوی احراز هویت: `user` را از همان `getCurrentUser()` سمت سرور می‌گیریم و
//   به کلاینت پاس می‌دهیم. برای مهمان اصلاً چیزی رندر نمی‌شود (نه فرم خالی، نه خطای
//   401) تا `/subscription` عمومی و بدون خرابی بماند.
// - لحن خنثی؛ پیام نامعتبر از سرور می‌آید (`PROMO_CODE_INVALID`) و دست‌نخورده است.

import { useState } from "react"

import { api, ApiClientError } from "@/app/lib/api/client"
import { announceAiQuotaChanged } from "@/app/lib/aiQuotaEvents"
import { faDigits } from "@/app/lib/time"
import styles from "./subscription.module.css"

interface RedeemResult {
    grantedFeatures: string[]
    bonusAnalyzeUnits: number
    bonusPlanUnits: number
    periodStart: string
}

/**
 * خلاصهٔ آنچه واقعاً اضافه شد — چون `AiQuotaStatusBar` روی این صفحه نیست، نوار
 * سهمیه این‌جا دیده نمی‌شود و کاربر باید از خودِ پاسخ بفهمد چه چیزی گرفته است.
 */
function grantedSummary(result: RedeemResult): string | null {
    const parts: string[] = []
    if (result.bonusAnalyzeUnits > 0) {
        parts.push(`${faDigits(result.bonusAnalyzeUnits)} تحلیل هوشمند`)
    }
    if (result.bonusPlanUnits > 0) {
        parts.push(`${faDigits(result.bonusPlanUnits)} برنامه‌ریزی هوشمند`)
    }
    if (parts.length === 0) return null
    return `${parts.join(" و ")} به سهمیهٔ این دوره اضافه شد`
}

export default function PromoRedeemBox({ user }: { user: { id: number } | null }) {
    const [code, setCode] = useState("")
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [success, setSuccess] = useState<string | null>(null)
    const [summary, setSummary] = useState<string | null>(null)

    // مهمان: /subscription باید مثل قبل قابل استفاده بماند، پس فقط این بخش
    // برای کاربر احراز‌شده رندر می‌شود.
    if (!user) return null

    const submit = async (e: React.FormEvent) => {
        e.preventDefault()
        if (busy) return
        const trimmed = code.trim()
        if (trimmed.length === 0) return

        setBusy(true)
        setError(null)
        setSuccess(null)
        setSummary(null)
        try {
            const result = await api<RedeemResult>("/api/promo/redeem", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ code: trimmed }),
            })
            setCode("")
            setSuccess("کد هدیه اعمال شد")
            setSummary(grantedSummary(result))
            // اگر `AiQuotaStatusBar` جایی mount باشد، نوار سهمیه بلافاصله تازه می‌شود.
            announceAiQuotaChanged()
        } catch (err) {
            setError(err instanceof ApiClientError ? err.message : "اعمال کد هدیه ناموفق بود")
        } finally {
            setBusy(false)
        }
    }

    return (
        <section className={styles.promoBox} aria-label="ورود کد هدیه">
            <h2 className={styles.promoTitle}>کد هدیه دارید؟</h2>
            <p className={styles.promoHint}>
                با وارد کردن کد هدیه می‌توانید سهمیه هوش مصنوعی خود را افزایش دهید.
            </p>

            <form onSubmit={submit} className={styles.promoForm}>
                <input
                    type="text"
                    className="dp-input"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    placeholder="کد هدیه را وارد کنید"
                    aria-label="کد هدیه"
                    dir="ltr"
                />
                <button
                    type="submit"
                    className="dp-btn dp-btn-primary"
                    disabled={busy || code.trim().length === 0}
                >
                    {busy ? "…" : "اعمال"}
                </button>
            </form>

            {error !== null && (
                <div className={styles.promoError} role="alert">
                    {error}
                </div>
            )}
            {success !== null && (
                <div className={styles.promoSuccess} role="status">
                    {success}
                    {summary !== null && <span className={styles.promoSummary}>{summary}</span>}
                </div>
            )}
        </section>
    )
}
