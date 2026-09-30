"use client"

// Admin V2 — /admin/promo-codes — فهرست/ساخت/فعال‌سازی کد هدیه
//
// منبع داده: GET /api/admin/promo-codes (listPromoCodes) + POST (createPromoCode)
// + PATCH /[id] (setPromoCodeActive). هیچ update کامل وجود ندارد (سرویس update ندارد).
// audit سمت سرور با promo.created / promo.updated ثبت می‌شود.
//
// status یک display state است (فعال/غیرفعال/منقضی/آینده) و در DB ذخیره نمی‌شود.

import Link from "next/link"
import { useCallback, useState } from "react"
import { Ticket, Link2, Plus } from "lucide-react"
import {
    createAdminPromoCode,
    fetchAdminPromoCodes,
    setAdminPromoCodeActive,
} from "@/app/lib/admin/adminClient"
import { useAdminQuery } from "@/app/lib/admin/useAdminQuery"
import {
    faDigits,
    formatTimestamp,
    maxRedemptionsLabel,
    promoStatusLabel,
    promoStatusTone,
    resolvePromoStatus,
} from "@/app/lib/admin/adminViewModels"
import {
    AdminAccessGate,
    AdminEmpty,
    AdminErrorState,
    AdminLoading,
    AdminNavTabs,
} from "../AdminUi"
import styles from "../admin.module.css"

interface FormState {
    code: string
    validFrom: string
    expiresAt: string
    maxRedemptions: string
    bonusAnalyzeUnits: string
    bonusPlanUnits: string
}

const EMPTY_FORM: FormState = {
    code: "",
    validFrom: "",
    expiresAt: "",
    maxRedemptions: "",
    bonusAnalyzeUnits: "0",
    bonusPlanUnits: "0",
}

export default function AdminPromoCodesPage() {
    const fetcher = useCallback((signal: AbortSignal) => fetchAdminPromoCodes(signal), [])
    const { data, loading, error, refetch } = useAdminQuery("/api/admin/promo-codes", fetcher)

    const [form, setForm] = useState<FormState>(EMPTY_FORM)
    const [submitting, setSubmitting] = useState(false)
    const [formError, setFormError] = useState<string | null>(null)
    const [notice, setNotice] = useState<string | null>(null)
    const [busyId, setBusyId] = useState<string | null>(null)

    const submit = useCallback(
        async (e: React.FormEvent) => {
            e.preventDefault()
            setFormError(null)
            setNotice(null)

            const analyze = Number(form.bonusAnalyzeUnits || "0")
            const plan = Number(form.bonusPlanUnits || "0")
            const maxRaw = form.maxRedemptions.trim()
            const max = maxRaw === "" ? null : Number(maxRaw)
            const from = new Date(form.validFrom)
            const until = new Date(form.expiresAt)

            if (!form.code.trim()) return setFormError("کد هدیه لازم است")
            if (Number.isNaN(from.getTime()) || Number.isNaN(until.getTime())) {
                return setFormError("تاریخ شروع و پایان لازم است")
            }
            if (!(until.getTime() > from.getTime())) return setFormError("زمان پایان باید بعد از زمان شروع باشد")
            if (max !== null && (!Number.isInteger(max) || max < 1)) {
                return setFormError("سقف ریدیمپشن باید عدد صحیح ≥ ۱ باشد")
            }
            if (!Number.isInteger(analyze) || analyze < 0 || !Number.isInteger(plan) || plan < 0) {
                return setFormError("مقادیر بونوس باید عدد صحیح نامنفی باشند")
            }
            if (analyze + plan < 1) return setFormError("حداقل یک واحد بونوس لازم است")

            setSubmitting(true)
            try {
                await createAdminPromoCode({
                    code: form.code.trim(),
                    validFrom: from.toISOString(),
                    expiresAt: until.toISOString(),
                    maxRedemptions: max,
                    bonusAnalyzeUnits: analyze,
                    bonusPlanUnits: plan,
                })
                setForm(EMPTY_FORM)
                setNotice("کد هدیه ساخته شد")
                refetch()
            } catch (err) {
                setFormError(err instanceof Error ? err.message : "ساخت کد ناموفق بود")
            } finally {
                setSubmitting(false)
            }
        },
        [form, refetch],
    )

    const toggle = useCallback(
        async (id: string, isActive: boolean) => {
            setBusyId(id)
            setNotice(null)
            try {
                await setAdminPromoCodeActive(id, isActive)
                refetch()
            } catch (err) {
                setFormError(err instanceof Error ? err.message : "تغییر وضعیت ناموفق بود")
            } finally {
                setBusyId(null)
            }
        },
        [refetch],
    )

    if (error !== null && (error.status === 401 || error.status === 403)) {
        return (
            <div className={styles.page}>
                <PageHead />
                <AdminAccessGate error={`${error.status} ${error.code}`} loading={false} />
            </div>
        )
    }

    const items = data?.items ?? []
    const now = new Date()

    return (
        <div className={styles.page}>
            <PageHead />

            <section className={styles.section} aria-label="ساخت کد هدیه">
                <h2 className={styles.sectionTitle}>
                    <Plus size={16} aria-hidden="true" /> کد هدیه‌ی تازه
                </h2>
                <form onSubmit={submit}>
                    <div className={styles.filterBar}>
                        <label className={styles.filterLabel}>
                            کد
                            <input
                                type="text"
                                className={styles.filterInput}
                                value={form.code}
                                onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))}
                                dir="ltr"
                                aria-label="کد هدیه"
                            />
                        </label>
                        <label className={styles.filterLabel}>
                            شروع
                            <input
                                type="datetime-local"
                                className={styles.filterInput}
                                value={form.validFrom}
                                onChange={(e) => setForm((f) => ({ ...f, validFrom: e.target.value }))}
                                aria-label="شروع اعتبار"
                            />
                        </label>
                        <label className={styles.filterLabel}>
                            پایان
                            <input
                                type="datetime-local"
                                className={styles.filterInput}
                                value={form.expiresAt}
                                onChange={(e) => setForm((f) => ({ ...f, expiresAt: e.target.value }))}
                                aria-label="پایان اعتبار"
                            />
                        </label>
                        <label className={styles.filterLabel}>
                            سقف ریدیمپشن
                            <input
                                type="text"
                                inputMode="numeric"
                                className={styles.filterInput}
                                value={form.maxRedemptions}
                                placeholder="بدون سقف"
                                onChange={(e) => setForm((f) => ({ ...f, maxRedemptions: e.target.value }))}
                                aria-label="سقف ریدیمپشن"
                            />
                        </label>
                        <label className={styles.filterLabel}>
                            بونوس تحلیل
                            <input
                                type="text"
                                inputMode="numeric"
                                className={styles.filterInput}
                                value={form.bonusAnalyzeUnits}
                                onChange={(e) => setForm((f) => ({ ...f, bonusAnalyzeUnits: e.target.value }))}
                                aria-label="بونوس تحلیل"
                            />
                        </label>
                        <label className={styles.filterLabel}>
                            بونوس برنامه‌ریزی
                            <input
                                type="text"
                                inputMode="numeric"
                                className={styles.filterInput}
                                value={form.bonusPlanUnits}
                                onChange={(e) => setForm((f) => ({ ...f, bonusPlanUnits: e.target.value }))}
                                aria-label="بونوس برنامه‌ریزی"
                            />
                        </label>
                        <button type="submit" className="dp-btn dp-btn-primary" disabled={submitting}>
                            <Plus size={15} aria-hidden="true" /> ساخت
                        </button>
                    </div>
                    {formError !== null && (
                        <p className={styles.cardItemMeta} role="alert">
                            {formError}
                        </p>
                    )}
                    {notice !== null && <p className={styles.statHint}>{notice}</p>}
                </form>
            </section>

            {loading && data === null && <AdminLoading label="در حال دریافت کدهای هدیه…" />}
            {error !== null && <AdminErrorState message={error.message} onRetry={refetch} />}
            {data !== null && items.length === 0 && <AdminEmpty message="هنوز کد هدیه‌ای ساخته نشده است." />}

            {items.length > 0 && (
                <section className={styles.section} aria-label="فهرست کدهای هدیه">
                    <div className={styles.tableScroll}>
                        <table className={styles.table}>
                            <thead>
                                <tr>
                                    <th scope="col">کد</th>
                                    <th scope="col">وضعیت</th>
                                    <th scope="col">شروع</th>
                                    <th scope="col">پایان</th>
                                    <th scope="col">سقف</th>
                                    <th scope="col">استفاده‌شده</th>
                                    <th scope="col">بونوس تحلیل</th>
                                    <th scope="col">بونوس برنامه‌ریزی</th>
                                    <th scope="col">ساخته‌شده</th>
                                    <th scope="col">اقدام</th>
                                </tr>
                            </thead>
                            <tbody>
                                {items.map((p) => {
                                    const status = resolvePromoStatus(p, now)
                                    const tone = promoStatusTone(status)
                                    const chipClass =
                                        tone === "ok"
                                            ? styles.chipRoleAdmin
                                            : tone === "warn"
                                              ? styles.chipWarning
                                              : ""
                                    return (
                                        <tr key={p.id}>
                                            <td className={styles.mono} dir="ltr">
                                                {p.code}
                                            </td>
                                            <td>
                                                <span className={`${styles.chip} ${chipClass}`}>
                                                    {promoStatusLabel(status)}
                                                </span>
                                            </td>
                                            <td>{formatTimestamp(p.validFrom)}</td>
                                            <td>{formatTimestamp(p.expiresAt)}</td>
                                            <td>{maxRedemptionsLabel(p.maxRedemptions)}</td>
                                            <td>{faDigits(p.redeemedCount)}</td>
                                            <td>{faDigits(p.bonusAnalyzeUnits)}</td>
                                            <td>{faDigits(p.bonusPlanUnits)}</td>
                                            <td>{formatTimestamp(p.createdAt)}</td>
                                            <td>
                                                <div className={styles.chipRow}>
                                                    <button
                                                        type="button"
                                                        className="dp-btn dp-btn-ghost"
                                                        disabled={busyId === p.id}
                                                        onClick={() => void toggle(p.id, !p.isActive)}
                                                    >
                                                        {p.isActive ? "غیرفعال" : "فعال"}
                                                    </button>
                                                    <Link
                                                        href={`/admin/audit?targetType=promo_code&targetId=${encodeURIComponent(p.id)}`}
                                                        className={styles.rowLink}
                                                    >
                                                        <Link2 size={13} aria-hidden="true" /> تاریخچه
                                                    </Link>
                                                </div>
                                            </td>
                                        </tr>
                                    )
                                })}
                            </tbody>
                        </table>
                    </div>
                </section>
            )}
        </div>
    )
}

function PageHead() {
    return (
        <header className={styles.pageHead}>
            <div>
                <h1 className={styles.pageTitle}>
                    <Ticket size={18} aria-hidden="true" style={{ verticalAlign: "-3px" }} /> کدهای هدیه
                </h1>
                <p className={styles.pageSub}>
                    ساخت و فعال/غیرفعال‌سازی کدهای هدیه‌ی سهمیه‌ی AI.
                </p>
            </div>
            <div className={styles.headSpacer} />
            <AdminNavTabs active="/admin/promo-codes" />
        </header>
    )
}
