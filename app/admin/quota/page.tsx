"use client"

// Admin V2 — /admin/quota — مشاهده و ویرایش ۴ سقف policy (FREE/PRO × ANALYZE/PLAN)
//
// منبع داده: GET /api/admin/quota-policy (policies + cutoverAt + mode + periodStart)
// و POST /api/admin/quota-policy برای ویرایش.
//
// هیچ عددی (۱۵/۲/۲۷۰/۵۰) در این فایل نیست؛ همه از API خوانده می‌شود. audit با
// before/after سمت سرور ثبت می‌شود. لحن خنثی — بدون gamification.

import Link from "next/link"
import { useCallback, useEffect, useState } from "react"
import { Gauge, Link2, Save } from "lucide-react"
import {
    fetchAdminQuotaPolicy,
    updateAdminQuotaPolicy,
} from "@/app/lib/admin/adminClient"
import { useAdminQuery } from "@/app/lib/admin/useAdminQuery"
import {
    faDigits,
    formatTimestamp,
    orderQuotaPolicies,
    planLabel,
    quotaFeatureLabel,
} from "@/app/lib/admin/adminViewModels"
import type { AdminQuotaPolicyView } from "@/app/lib/admin/adminTypes"
import {
    AdminAccessGate,
    AdminEmpty,
    AdminErrorState,
    AdminLoading,
    AdminNavTabs,
} from "../AdminUi"
import styles from "../admin.module.css"

export default function AdminQuotaPage() {
    const fetcher = useCallback((signal: AbortSignal) => fetchAdminQuotaPolicy(signal), [])
    const { data, loading, error, refetch } = useAdminQuery("/api/admin/quota-policy", fetcher)

    const [drafts, setDrafts] = useState<Record<string, string>>({})
    const [savingKey, setSavingKey] = useState<string | null>(null)
    const [rowErrors, setRowErrors] = useState<Record<string, string>>({})
    const [notice, setNotice] = useState<string | null>(null)

    // وقتی داده تازه رسید، draftهای ذخیره‌نشده را با مقدار سرور هم‌راستا می‌کنیم.
    useEffect(() => {
        if (data === null) return
        const next: Record<string, string> = {}
        for (const p of data.policies) next[policyKey(p)] = String(p.allowedUnits)
        setDrafts(next)
    }, [data])

    const save = useCallback(
        async (row: AdminQuotaPolicyView) => {
            const key = policyKey(row)
            const raw = drafts[key] ?? String(row.allowedUnits)
            const value = Number(raw.trim())
            if (!Number.isInteger(value) || value < 0) {
                setRowErrors((prev) => ({ ...prev, [key]: "فقط عدد صحیح نامنفی مجاز است" }))
                return
            }
            setRowErrors((prev) => {
                const next = { ...prev }
                delete next[key]
                return next
            })
            setNotice(null)
            setSavingKey(key)
            try {
                await updateAdminQuotaPolicy({
                    plan: row.plan,
                    feature: row.feature,
                    allowedUnits: value,
                })
                setNotice("سقف سهمیه به‌روزرسانی شد")
                refetch()
            } catch (e) {
                setRowErrors((prev) => ({
                    ...prev,
                    [key]: e instanceof Error ? e.message : "ذخیره ناموفق بود",
                }))
            } finally {
                setSavingKey(null)
            }
        },
        [drafts, refetch],
    )

    if (error !== null && (error.status === 401 || error.status === 403)) {
        return (
            <div className={styles.page}>
                <PageHead />
                <AdminAccessGate error={`${error.status} ${error.code}`} loading={false} />
            </div>
        )
    }

    return (
        <div className={styles.page}>
            <PageHead />

            {loading && data === null && <AdminLoading label="در حال دریافت سقف‌های سهمیه…" />}
            {error !== null && <AdminErrorState message={error.message} onRetry={refetch} />}
            {data !== null && data.policies.length === 0 && (
                <AdminEmpty message="هیچ ردیف policy سهمیه‌ای یافت نشد." />
            )}

            {data !== null && data.policies.length > 0 && (
                <>
                    <section className={styles.section} aria-label="زمینه‌ی گذار سهمیه">
                        <dl className={styles.defList}>
                            <dt>حالت دوره (mode)</dt>
                            <dd>{data.mode === "NEW" ? "NEW (bucket V2)" : "LEGACY"}</dd>
                            <dt>مرز گذار (cutoverAt)</dt>
                            <dd>{formatTimestamp(data.cutoverAt)}</dd>
                            <dt>شروع دوره‌ی جاری</dt>
                            <dd>{formatTimestamp(data.periodStart)}</dd>
                        </dl>
                    </section>

                    {notice !== null && <p className={styles.statHint}>{notice}</p>}

                    <section className={styles.section} aria-label="سقف‌های سهمیه">
                        <div className={styles.tableScroll}>
                            <table className={styles.table}>
                                <thead>
                                    <tr>
                                        <th scope="col">طرح</th>
                                        <th scope="col">قابلیت</th>
                                        <th scope="col">سقف فعلی</th>
                                        <th scope="col">ویرایش</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {orderQuotaPolicies(data.policies).map((row) => {
                                        const key = policyKey(row)
                                        const value = drafts[key] ?? String(row.allowedUnits)
                                        const busy = savingKey === key
                                        return (
                                            <tr key={key}>
                                                <td>{planLabel(row.plan)}</td>
                                                <td>{quotaFeatureLabel(row.feature)}</td>
                                                <td>{faDigits(row.allowedUnits)}</td>
                                                <td>
                                                    <div className={styles.chipRow}>
                                                        <input
                                                            type="text"
                                                            inputMode="numeric"
                                                            className={styles.filterInput}
                                                            value={value}
                                                            aria-label={`سقف ${planLabel(row.plan)} ${quotaFeatureLabel(row.feature)}`}
                                                            onChange={(e) =>
                                                                setDrafts((prev) => ({ ...prev, [key]: e.target.value }))
                                                            }
                                                        />
                                                        <button
                                                            type="button"
                                                            className="dp-btn dp-btn-ghost"
                                                            onClick={() => void save(row)}
                                                            disabled={busy}
                                                        >
                                                            <Save size={14} aria-hidden="true" /> ذخیره
                                                        </button>
                                                    </div>
                                                    {rowErrors[key] !== undefined && (
                                                        <div className={styles.cardItemMeta} role="alert">
                                                            {rowErrors[key]}
                                                        </div>
                                                    )}
                                                </td>
                                            </tr>
                                        )
                                    })}
                                </tbody>
                            </table>
                        </div>
                    </section>

                    <p className={styles.statHint}>
                        <Link href="/admin/audit?action=quota_policy.updated" className={styles.rowLink}>
                            <Link2 size={13} aria-hidden="true" /> مشاهده‌ی تاریخچه‌ی تغییرات
                        </Link>
                    </p>
                </>
            )}
        </div>
    )
}

function policyKey(row: AdminQuotaPolicyView): string {
    return `${row.plan}:${row.feature}`
}

function PageHead() {
    return (
        <header className={styles.pageHead}>
            <div>
                <h1 className={styles.pageTitle}>
                    <Gauge size={18} aria-hidden="true" style={{ verticalAlign: "-3px" }} /> سقف‌های سهمیه‌ی AI
                </h1>
                <p className={styles.pageSub}>
                    مشاهده و ویرایش سقف FREE/PRO برای تحلیل و برنامه‌ریزی — بدون deploy.
                </p>
            </div>
            <div className={styles.headSpacer} />
            <AdminNavTabs active="/admin/quota" />
        </header>
    )
}
