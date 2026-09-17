"use client"

// فاز ۴ — Step 7: صفحه‌ی /admin — نمای کلی عملیاتی (read-only)
//
// منبع داده: GET /api/admin/overview (Step 6) — چهار widget مستقل §12:
//   users (DAU/WAU/MAU) | activity | aiQuota | errors
// شکست هر widget فقط همان بخش را unavailable می‌کند — هیچ metric جدیدی ساخته نمی‌شود.
// هیچ کنترل تغییر وضعیت (role/plan/quota) وجود ندارد — کاملاً read-only.

import Link from "next/link"
import { useCallback } from "react"
import { Activity, BarChart3, Bot, ShieldCheck, Users } from "lucide-react"
import { fetchAdminOverview } from "@/app/lib/admin/adminClient"
import { useAdminQuery } from "@/app/lib/admin/useAdminQuery"
import { buildOverviewVM, faDigits, formatTimestamp } from "@/app/lib/admin/adminViewModels"
import {
    AdminAccessGate,
    AdminEmpty,
    AdminErrorState,
    AdminLoading,
    AdminNavTabs,
    AdminStatCard,
} from "./AdminUi"
import styles from "./admin.module.css"

export default function AdminOverviewPage() {
    const fetcher = useCallback((signal: AbortSignal) => fetchAdminOverview(signal), [])
    const { data, loading, error, refetch } = useAdminQuery("/api/admin/overview", fetcher)
    const vm = buildOverviewVM(data)

    if (loading && data === null) {
        return (
            <div className={styles.page}>
                <PageHead />
                <AdminLoading label="در حال دریافت نمای کلی…" />
            </div>
        )
    }

    // 401/403 → پیام UX؛ امنیت همچنان server-side است
    if (error !== null && (error.status === 401 || error.status === 403)) {
        return (
            <div className={styles.page}>
                <PageHead />
                <AdminAccessGate error={`${error.status} ${error.code}`} loading={false} />
            </div>
        )
    }

    if (error !== null) {
        return (
            <div className={styles.page}>
                <PageHead />
                <AdminErrorState message={error.message} onRetry={refetch} />
            </div>
        )
    }

    const hasAnyWidget = vm.activity !== null || vm.aiQuota !== null || vm.errors !== null

    return (
        <div className={styles.page}>
            <PageHead />

            <section aria-labelledby="admin-users-heading" className={styles.section}>
                <h2 id="admin-users-heading" className={styles.sectionTitle}>
                    <Users size={16} aria-hidden="true" /> کاربران فعال
                </h2>
                <div className={styles.statsWrap}>
                    <AdminStatCard label="فعال امروز (DAU)" value={faDigits(vm.users.dau)} icon={<Activity size={14} />} />
                    <AdminStatCard label="فعال هفته (WAU)" value={faDigits(vm.users.wau)} icon={<Activity size={14} />} />
                    <AdminStatCard label="فعال ماه (MAU)" value={faDigits(vm.users.mau)} icon={<Activity size={14} />} />
                </div>
            </section>

            <div className={styles.sectionGrid}>
                {/* widget 2 — activity (fail-open؛ غیبت = فقط مخفی) */}
                {vm.activity !== null && (
                    <section aria-labelledby="admin-activity-heading" className={styles.section}>
                        <h2 id="admin-activity-heading" className={styles.sectionTitle}>
                            <BarChart3 size={16} aria-hidden="true" /> فعالیت {faDigits(vm.activity.windowHours)} ساعت اخیر
                        </h2>
                        {vm.activity.byEventName.length === 0 ? (
                            <AdminEmpty message="رویداد فعالیتی در این بازه ثبت نشده است." />
                        ) : (
                            <>
                                <p className={styles.statHint}>
                                    مجموع رویدادها: {faDigits(vm.activity.totalInWindow)}
                                </p>
                                <div className={styles.countList}>
                                    {vm.activity.byEventName.slice(0, 8).map((row) => (
                                        <div key={row.eventName} className={styles.countRow}>
                                            <span>{row.eventName}</span>
                                            <span>{faDigits(row.count)}</span>
                                        </div>
                                    ))}
                                </div>
                            </>
                        )}
                    </section>
                )}

                {/* widget 3 — aiQuota (null = unavailable؛ جعل داده ممنوع) */}
                {vm.aiQuota !== null && (
                    <section aria-labelledby="admin-ai-heading" className={styles.section}>
                        <h2 id="admin-ai-heading" className={styles.sectionTitle}>
                            <Bot size={16} aria-hidden="true" /> مصرف AI دوره‌ی جاری
                        </h2>
                        <dl className={styles.defList}>
                            <dt>شروع دوره</dt>
                            <dd>{formatTimestamp(vm.aiQuota.periodStart)}</dd>
                            <dt>واحد رزرو شده</dt>
                            <dd>{faDigits(vm.aiQuota.reservedUnits)}</dd>
                            <dt>واحد مصرف‌شده</dt>
                            <dd>{faDigits(vm.aiQuota.consumedUnits)}</dd>
                        </dl>
                    </section>
                )}

                {/* widget 4 — errors */}
                {vm.errors !== null && (
                    <section aria-labelledby="admin-errors-heading" className={styles.section}>
                        <h2 id="admin-errors-heading" className={styles.sectionTitle}>
                            <ShieldCheck size={16} aria-hidden="true" /> خطاها {faDigits(vm.errors.windowHours)} ساعت اخیر
                        </h2>
                        {vm.errors.bySeverity.length === 0 ? (
                            <AdminEmpty message="خطایی در این بازه ثبت نشده است." />
                        ) : (
                            <>
                                <p className={styles.statHint}>
                                    مجموع خطاها: {faDigits(vm.errors.totalInWindow)}
                                </p>
                                <div className={styles.countList}>
                                    {vm.errors.bySeverity.map((row) => (
                                        <div key={row.severity} className={styles.countRow}>
                                            <span>{row.severity}</span>
                                            <span>{faDigits(row.count)}</span>
                                        </div>
                                    ))}
                                </div>
                                {vm.errors.topErrors.length > 0 && (
                                    <div className={styles.countList}>
                                        {vm.errors.topErrors.map((row) => (
                                            <div key={row.errorCode} className={styles.countRow}>
                                                <span className="fa-digits">{row.errorCode}</span>
                                                <span>{faDigits(row.count)}</span>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </>
                        )}
                    </section>
                )}
            </div>

            {!hasAnyWidget && <AdminEmpty message="هیچ widget آماری در دسترس نیست — بعداً دوباره بررسی کنید." />}
        </div>
    )
}

function PageHead() {
    return (
        <header className={styles.pageHead}>
            <div>
                <h1 className={styles.pageTitle}>نمای کلی مدیریت</h1>
                <p className={styles.pageSub}>نمای read-only از وضعیت عملیاتی روزچین — فقط مشاهده.</p>
            </div>
            <div className={styles.headSpacer} />
            <AdminNavTabs active="/admin" />
            <Link href="/admin/users" className="dp-btn dp-btn-ghost">
                کاربران
            </Link>
            <Link href="/admin/errors" className="dp-btn dp-btn-ghost">
                خطاها
            </Link>
        </header>
    )
}
