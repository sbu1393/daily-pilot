"use client"

// مودال **غیرقابل dismiss** — «تعیین رمز عبور جدید».
//
// چرا مودال اختصاصی و نه `AnimatedModal` موجود؟
// `AnimatedModal` روی کلیک overlay و کلید Escape بسته می‌شود (`AnimatedModal.tsx:21-24`).
// در این جریان، بستن مودال یعنی دور زدن enforcement: کاربر می‌تواند در داشبورد
// بماند یا صفحه را ترک کند در حالی که هنوز رمز دائمی تعیین نکرده است. پس اینجا
// **هیچ راه خروجی نیست** — نه Escape، نه کلیک بیرون، نه دکمهٔ بستن.
//
// نکتهٔ مهم: non-dismissible به‌تنهایی امنیت نیست. مرز امنیتی واقعی، گارد مرکزی
// `requireVerifiedUser` روی همهٔ /api/* است؛ این مودال فقط لایهٔ UX است تا
// کاربر بداند چرا همه‌چیز قفل است و چه باید بکند.

import { useState } from "react"

import { api } from "@/app/lib/api/client"
import styles from "@/app/components/task/task.module.css"

type Props = {
    /** فقط برای تست‌ها/کنترل بیرونی؛ در عمل همیشه true در این صفحه. */
    open: boolean
    onSuccess: () => void
}

export default function ForcedPasswordModal({ open, onSuccess }: Props) {
    const [newPassword, setNewPassword] = useState("")
    const [confirm, setConfirm] = useState("")
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)

    // Escape عمداً اینجا bind نمی‌شود (برخلاف AnimatedModal) — بخشی از «غیرقابل
    // بستن» بودن همین است.

    const submit = async (e: React.FormEvent) => {
        e.preventDefault()
        if (busy) return
        if (newPassword !== confirm) {
            setError("رمز عبور جدید و تکرار آن یکسان نیست")
            return
        }
        if (newPassword.length < 8) {
            setError("رمز عبور جدید حداقل ۸ کاراکتر باشد")
            return
        }

        setBusy(true)
        setError(null)
        try {
            await api("/api/auth/set-new-password", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ newPassword, newPasswordConfirm: confirm }),
            })
            onSuccess()
        } catch (err) {
            setError(err instanceof Error ? err.message : "تغییر رمز عبور ناموفق بود")
        } finally {
            setBusy(false)
        }
    }

    if (!open) return null

    return (
        <div className={styles.overlay}>
            <div
                className={styles.modal}
                role="dialog"
                aria-modal="true"
                aria-label="تعیین رمز عبور جدید"
                style={{ cursor: "default" }}
            >
                <div className={styles.modalHead}>
                    <h4>لطفاً رمز عبور جدید خود را تعیین کنید</h4>
                </div>

                <p className={styles.hint}>
                    شما با رمز موقت وارد شده‌اید. تا زمانی که رمز عبور دائمی تعیین
                    نکنید، امکان استفاده از امکانات برنامه وجود ندارد.
                </p>

                <form onSubmit={submit} className="dp-form">
                    <div className="dp-field">
                        <label className="dp-field-label" htmlFor="new-password">
                            رمز عبور جدید
                        </label>
                        <input
                            id="new-password"
                            type="password"
                            className="dp-input"
                            value={newPassword}
                            onChange={(e) => setNewPassword(e.target.value)}
                            placeholder="حداقل ۸ کاراکتر"
                            autoComplete="new-password"
                        />
                    </div>

                    <div className="dp-field">
                        <label className="dp-field-label" htmlFor="confirm-password">
                            تکرار رمز عبور جدید
                        </label>
                        <input
                            id="confirm-password"
                            type="password"
                            className="dp-input"
                            value={confirm}
                            onChange={(e) => setConfirm(e.target.value)}
                            placeholder="رمز عبور جدید را دوباره وارد کنید"
                            autoComplete="new-password"
                        />
                    </div>

                    {error !== null && (
                        <div className={styles.formError} role="alert">
                            {error}
                        </div>
                    )}

                    <button
                        type="submit"
                        className="dp-btn dp-btn-primary dp-btn-block"
                        disabled={busy}
                    >
                        {busy ? "در حال ذخیره…" : "تعیین رمز عبور"}
                    </button>
                </form>
            </div>
        </div>
    )
}
