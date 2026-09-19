"use client"

// فاز ۴ — Step 7 (+ داشبورد عملیاتی): صفحه‌ی /admin — نمای کلی عملیاتی (read-only)
//
// منبع داده: GET /api/admin/overview (Step 6) — همان چهار widget قراردادی (§12) به‌علاوه‌ی
// widgetهای از قبل در API موجود: aiUsage | billing | recentErrors.
//   users (کل/DAU/WAU/MAU) | activity | aiQuota | aiUsage | errors | billing | recentErrors
// شکست هر widget فقط همان بخش را unavailable می‌کند (fail-open؛ هیچ عدد جعلی ساخته نمی‌شود).
// هیچ کنترل تغییر وضعیت (role/plan/quota) وجود ندارد — کاملاً read-only.
// Privacy: ایمیل هرگز این‌جا نیست، metadata/stack خطا وارد UI نمی‌شود و شناسه‌ی پرداخت ماسک می‌شود.

import Link from "next/link"
import { useCallback } from "react"
import {
    Activity,
    BarChart3,
    Bot,
    CreditCard,
    ShieldAlert,
    ShieldCheck,
    TriangleAlert,
    Users,
    Zap,
} from "lucide-react"
import { fetchAdminOverview } from "@/app/lib/admin/adminClient"
import { useAdminQuery } from "@/app/lib/admin/useAdminQuery"
import {
    buildOverviewVM,
    countBySeverity,
    faDigits,
    formatTimestamp,
    maskIdTail,
    paymentStatusLabel,
} from "@/app/lib/admin/adminViewModels"
import {
    AdminAccessGate,
    AdminEmpty,
    AdminErrorState,
    AdminLoading,
    AdminNavTabs,
    AdminStatCard,
    SeverityChip,
} from "./AdminUi"
import styles from "./admin.module.css"

/** نمایش عدد KPI — مقدار ناموجود با «—» (هیچ صفر جعلی جای null نمی‌گذارد). */
function kpiNumber(value: number | null | undefined): string {
    return typeof value === "number" && Number.isFinite(value) ? faDigits(value) : "—"
}

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

    const severity = countBySeverity(vm.errors?.bySeverity ?? [])
    const hasAnyWidget =
        vm.activity !== null ||
        vm.aiQuota !== null ||
        vm.aiUsage !== null ||
        vm.errors !== null ||
        vm.billing !== null ||
        vm.recentErrors.length > 0

    return (
        <div className={styles.page}>
            <PageHead />

            {/* ---------- دسترسی سریع ---------- */}
            <section aria-labelledby="admin-quick-heading" className={styles.section}>
                <h2 id="admin-quick-heading" className={styles.sectionTitle}>
                    <Zap size={16} aria-hidden="true" /> دسترسی سریع
                </h2>
                <div className={styles.chipRow}>
                    <Link href="/admin/users" className="dp-btn dp-btn-ghost">
                        کاربران (جستجو، طرح، آخرین فعالیت)
                    </Link>
                    <Link href="/admin/errors" className="dp-btn dp-btn-ghost">
                        خطاهای عملیاتی (فیلتر شدت/کد/endpoint)
                    </Link>
                    <Link href="/dashboard" className="dp-btn dp-btn-ghost">
                        داشبورد کاربر
                    </Link>
                </div>
            </section>

            {/* ---------- KPI: کاربران ---------- */}
            <section aria-labelledby="admin-users-heading" className={styles.section}>
                <h2 id="admin-users-heading" className={styles.sectionTitle}>
                    <Users size={16} aria-hidden="true" /> کاربران
                </h2>
                <div className={styles.statsWrap}>
                    <AdminStatCard
                        label="کل کاربران ثبت‌شده"
                        value={kpiNumber(vm.users.total)}
                        hint={vm.users.total === null ? "در دسترس نیست" : undefined}
                        icon={<Users size={14} />}
                    />
                    <AdminStatCard
                        label="فعال ۲۴ ساعت (DAU)"
                        value={faDigits(vm.users.dau)}
                        icon={<Activity size={14} />}
                    />
                    <AdminStatCard
                        label="فعال ۷ روز (WAU)"
                        value={faDigits(vm.users.wau)}
                        icon={<Activity size={14} />}
                    />
                    <AdminStatCard
                        label="فعال ۳۰ روز (MAU)"
                        value={faDigits(vm.users.mau)}
                        icon={<Activity size={14} />}
                    />
                </div>
            </section>

            {/* ---------- KPI: خطاها و هوش مصنوعی ---------- */}
            <section aria-labelledby="admin-ops-heading" className={styles.section}>
                <h2 id="admin-ops-heading" className={styles.sectionTitle}>
                    <ShieldCheck size={16} aria-hidden="true" /> خطاها و درخواست‌های AI
                </h2>
                <div className={styles.statsWrap}>
                    <AdminStatCard
                        label="خطای ۲۴ ساعت اخیر"
                        value={vm.errors === null ? "—" : faDigits(vm.errors.totalInWindow)}
                        hint={vm.errors === null ? "در دسترس نیست" : undefined}
                        icon={<ShieldAlert size={14} />}
                    />
                    <AdminStatCard
                        label="کل خطاهای ثبت‌شده"
                        value={kpiNumber(vm.errors?.totalAllTime)}
                        hint={vm.errors?.totalAllTime === null ? "در دسترس نیست" : undefined}
                        icon={<ShieldAlert size={14} />}
                    />
                    <AdminStatCard
                        label="خطای CRITICAL (۲۴ ساعت)"
                        value={vm.errors === null ? "—" : faDigits(severity.CRITICAL)}
                        icon={<TriangleAlert size={14} />}
                    />
                    <AdminStatCard
                        label="خطای ERROR (۲۴ ساعت)"
                        value={vm.errors === null ? "—" : faDigits(severity.ERROR)}
                        icon={<TriangleAlert size={14} />}
                    />
                    <AdminStatCard
                        label="هشدار WARNING (۲۴ ساعت)"
                        value={vm.errors === null ? "—" : faDigits(severity.WARNING)}
                        icon={<TriangleAlert size={14} />}
                    />
                    <AdminStatCard
                        label="درخواست AI (کل)"
                        value={kpiNumber(vm.aiUsage?.totalRequests)}
                        hint={vm.aiUsage === null ? "در دسترس نیست" : "هر رکورد = یک عملیات منطقی AI"}
                        icon={<Bot size={14} />}
                    />
                    <AdminStatCard
                        label="درخواست AI (۲۴ ساعت)"
                        value={kpiNumber(vm.aiUsage?.requestsInWindow)}
                        icon={<Bot size={14} />}
                    />
                    <AdminStatCard
                        label="واحد سهمیه‌ی مصرف‌شده (دوره‌ی جاری)"
                        value={kpiNumber(vm.aiQuota?.consumedUnits)}
                        hint={
                            vm.aiQuota === null
                                ? "در دسترس نیست"
                                : "معیار مصرف = واحد سهمیه (توکن ذخیره نمی‌شود)"
                        }
                        icon={<BarChart3 size={14} />}
                    />
                </div>
            </section>

            {/* ---------- KPI: اشتراک و پرداخت ---------- */}
            <section aria-labelledby="admin-sub-heading" className={styles.section}>
                <h2 id="admin-sub-heading" className={styles.sectionTitle}>
                    <CreditCard size={16} aria-hidden="true" /> اشتراک و پرداخت
                </h2>
                <div className={styles.statsWrap}>
                    <AdminStatCard
                        label="اشتراک فعال"
                        value={kpiNumber(vm.billing?.activeSubscriptions)}
                        hint={
                            vm.billing === null
                                ? "در دسترس نیست"
                                : "status=ACTIVE و currentPeriodEnd > اکنون"
                        }
                        icon={<CreditCard size={14} />}
                    />
                    <AdminStatCard
                        label={
                            vm.billing === null
                                ? "پرداخت موفق"
                                : `پرداخت موفق (${faDigits(vm.billing.windowDays)} روز اخیر)`
                        }
                        value={kpiNumber(vm.billing?.paidInWindow)}
                        icon={<CreditCard size={14} />}
                    />
                </div>
            </section>

            {/* ---------- widgetها ---------- */}
            <div className={styles.sectionGrid}>
                {/* widget 1 — errors (fail-open فاز ۲) */}
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

                {/* widget 2 — aiUsage (شکست → null) */}
                {vm.aiUsage !== null && (
                    <section aria-labelledby="admin-aiusage-heading" className={styles.section}>
                        <h2 id="admin-aiusage-heading" className={styles.sectionTitle}>
                            <Bot size={16} aria-hidden="true" /> درخواست‌های AI
                        </h2>
                        <dl className={styles.defList}>
                            <dt>کل درخواست‌ها</dt>
                            <dd>{faDigits(vm.aiUsage.totalRequests)}</dd>
                            <dt>در {faDigits(vm.aiUsage.windowHours)} ساعت اخیر</dt>
                            <dd>{faDigits(vm.aiUsage.requestsInWindow)}</dd>
                        </dl>
                        {vm.aiUsage.byStatus.length === 0 ? (
                            <AdminEmpty message="رکورد مصرفی برای درخواست‌های AI ثبت نشده است." />
                        ) : (
                            <div className={styles.countList}>
                                {vm.aiUsage.byStatus.map((row) => (
                                    <div key={row.status} className={styles.countRow}>
                                        <span>{row.status}</span>
                                        <span>{faDigits(row.count)}</span>
                                    </div>
                                ))}
                            </div>
                        )}
                    </section>
                )}

                {/* widget 3 — aiQuota (null = unavailable؛ جعل داده ممنوع) */}
                {vm.aiQuota !== null && (
                    <section aria-labelledby="admin-ai-heading" className={styles.section}>
                        <h2 id="admin-ai-heading" className={styles.sectionTitle}>
                            <BarChart3 size={16} aria-hidden="true" /> سهمیه‌ی AI دوره‌ی جاری
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

                {/* widget 4 — activity (fail-open؛ غیبت = فقط مخفی) */}
                {vm.activity !== null && (
                    <section aria-labelledby="admin-activity-heading" className={styles.section}>
                        <h2 id="admin-activity-heading" className={styles.sectionTitle}>
                            <Activity size={16} aria-hidden="true" /> فعالیت {faDigits(vm.activity.windowHours)} ساعت اخیر
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

                {/* widget 5 — billing (فقط state ذخیره‌شده؛ شکست → null) */}
                {vm.billing !== null && (
                    <section aria-labelledby="admin-billing-heading" className={styles.section}>
                        <h2 id="admin-billing-heading" className={styles.sectionTitle}>
                            <CreditCard size={16} aria-hidden="true" /> آخرین پرداخت‌ها
                        </h2>
                        {vm.billing.recentPayments.length === 0 ? (
                            <AdminEmpty message="سفارش پرداختی ثبت نشده است." />
                        ) : (
                            <>
                                <div className={styles.tableScroll}>
                                    <table className={styles.table}>
                                        <thead>
                                            <tr>
                                                <th scope="col">کاربر</th>
                                                <th scope="col">وضعیت</th>
                                                <th scope="col">مبلغ</th>
                                                <th scope="col">روز اشتراک</th>
                                                <th scope="col">تاریخ</th>
                                                <th scope="col">شناسه</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {vm.billing.recentPayments.map((payment) => (
                                                <tr key={payment.id}>
                                                    <td>
                                                        <Link
                                                            href={`/admin/users/${String(payment.userId)}`}
                                                            className={styles.rowLink}
                                                        >
                                                            {faDigits(payment.userId)}
                                                        </Link>
                                                    </td>
                                                    <td>{paymentStatusLabel(payment.status)}</td>
                                                    <td>
                                                        {faDigits(payment.amount)} {payment.currency}
                                                    </td>
                                                    <td>{faDigits(payment.entitlementDays)}</td>
                                                    <td>
                                                        {formatTimestamp(payment.paidAt ?? payment.createdAt)}
                                                    </td>
                                                    <td className={styles.mono} dir="ltr">
                                                        {maskIdTail(payment.id)}
                                                    </td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>

                                <ul className={styles.cardList}>
                                    {vm.billing.recentPayments.map((payment) => (
                                        <li key={payment.id} className={styles.cardItem}>
                                            <div className={styles.cardItemTop}>
                                                <span className={styles.cardItemTitle}>
                                                    {paymentStatusLabel(payment.status)}
                                                </span>
                                                <span className={styles.mono} dir="ltr">
                                                    {maskIdTail(payment.id)}
                                                </span>
                                            </div>
                                            <div className={styles.cardItemMeta}>
                                                کاربر {faDigits(payment.userId)} ·{" "}
                                                {faDigits(payment.amount)} {payment.currency} ·{" "}
                                                {faDigits(payment.entitlementDays)} روز
                                            </div>
                                            <div className={styles.cardItemMeta}>
                                                {formatTimestamp(payment.paidAt ?? payment.createdAt)}
                                            </div>
                                        </li>
                                    ))}
                                </ul>
                            </>
                        )}
                    </section>
                )}
            </div>

            {/* ---------- فید خطاهای اخیر ---------- */}
            <section aria-labelledby="admin-feed-heading" className={styles.section}>
                <h2 id="admin-feed-heading" className={styles.sectionTitle}>
                    <ShieldAlert size={16} aria-hidden="true" /> آخرین خطاهای ثبت‌شده
                </h2>
                {vm.recentErrors.length === 0 ? (
                    <AdminEmpty message="خطای اخیری ثبت نشده است." />
                ) : (
                    <>
                        <div className={styles.tableScroll}>
                            <table className={styles.table}>
                                <thead>
                                    <tr>
                                        <th scope="col">زمان</th>
                                        <th scope="col">شدت</th>
                                        <th scope="col">مسیر</th>
                                        <th scope="col">پیام</th>
                                        <th scope="col">کاربر</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {vm.recentErrors.map((log) => (
                                        <tr key={log.id}>
                                            <td>{formatTimestamp(log.createdAt)}</td>
                                            <td>
                                                <SeverityChip severity={log.severity} />
                                            </td>
                                            <td dir="ltr" className={styles.mono}>
                                                {log.endpoint}
                                            </td>
                                            <td className={styles.cardItemMsg}>{log.message}</td>
                                            <td>
                                                {log.userId === null ? "—" : faDigits(log.userId)}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>

                        <ul className={styles.cardList}>
                            {vm.recentErrors.map((log) => (
                                <li key={log.id} className={styles.cardItem}>
                                    <div className={styles.cardItemTop}>
                                        <SeverityChip severity={log.severity} />
                                        <span className={styles.cardItemMeta}>
                                            {formatTimestamp(log.createdAt)}
                                        </span>
                                    </div>
                                    <div className={styles.cardItemMeta} dir="ltr">
                                        {log.endpoint}
                                    </div>
                                    <div className={styles.cardItemMsg}>{log.message}</div>
                                    <div className={styles.cardItemMeta}>
                                        {log.userId === null
                                            ? "کاربر ناشناس"
                                            : `کاربر ${faDigits(log.userId)}`}
                                    </div>
                                </li>
                            ))}
                        </ul>
                    </>
                )}
                <p className={styles.statHint}>
                    <Link href="/admin/errors" className={styles.rowLink}>
                        مشاهده‌ی فهرست کامل با فیلترها
                    </Link>
                </p>
            </section>

            {!hasAnyWidget && (
                <AdminEmpty message="هیچ widget آماری در دسترس نیست — بعداً دوباره بررسی کنید." />
            )}
        </div>
    )
}

function PageHead() {
    return (
        <header className={styles.pageHead}>
            <div>
                <h1 className={styles.pageTitle}>نمای کلی مدیریت</h1>
                <p className={styles.pageSub}>
                    نمای read-only از وضعیت عملیاتی روزساز — کاربران، خطاها، مصرف AI و اشتراک‌ها.
                </p>
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
