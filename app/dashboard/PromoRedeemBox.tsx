"use client"

// AI Quota V2 — جعبه‌ی ورود کد هدیه (user-facing)
//
// - endpoint: POST /api/promo/redeem (فقط کد از کلاینت؛ userId از session).
// - بعد از موفقیت، رویداد سراسری سهمیه پخش می‌شود → نوار سهمیه تازه می‌شود.
// - لحن خنثی؛ پیام تغییرناپذیر عمومی برای کد نامعتبر از سرور می‌آید.

import { useState } from "react"
import { api, ApiClientError } from "@/app/lib/api/client"
import { announceAiQuotaChanged } from "@/app/lib/aiQuotaEvents"
import styles from "./dashboard.module.css"

interface RedeemResult {
    grantedFeatures: string[]
    bonusAnalyzeUnits: number
    bonusPlanUnits: number
    periodStart: string
}

export default function PromoRedeemBox() {
    const [code, setCode] = useState("")
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [success, setSuccess] = useState<string | null>(null)

    const submit = async (e: React.FormEvent) => {
        e.preventDefault()
        if (busy) return
        const trimmed = code.trim()
        if (trimmed.length === 0) return

        setBusy(true)
        setError(null)
        setSuccess(null)
        try {
            await api<RedeemResult>("/api/promo/redeem", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ code: trimmed }),
            })
            setCode("")
            setSuccess("کد هدیه اعمال شد")
            // نوار سهمیه بلافاصله تازه شود (همان رویداد سراسری موجود).
            announceAiQuotaChanged()
        } catch (err) {
            setError(err instanceof ApiClientError ? err.message : "اعمال کد هدیه ناموفق بود")
        } finally {
            setBusy(false)
        }
    }

    return (
        <section className={styles.quotaPanel} aria-label="ورود کد هدیه">
            <div className={styles.quotaPanelHead}>کد هدیه</div>
            <form onSubmit={submit} style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                <input
                    type="text"
                    className="dp-input"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    placeholder="کد هدیه را وارد کن"
                    aria-label="کد هدیه"
                    dir="ltr"
                />
                <button
                    type="submit"
                    className="dp-btn dp-btn-ghost"
                    disabled={busy || code.trim().length === 0}
                >
                    {busy ? "…" : "اعمال"}
                </button>
            </form>
            {error !== null && (
                <div className={styles.formError} role="alert">
                    {error}
                </div>
            )}
            {success !== null && <div className={styles.quotaPanelHead}>{success}</div>}
        </section>
    )
}
