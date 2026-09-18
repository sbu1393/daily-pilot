"use client"

// فاز ۴ — Step 7: صفحه‌ی /admin/users/[id] — جزئیات کاربر (read-only)
//
// منابع داده (Step 6):
//   GET /api/admin/users/[id]          → safe identity + activity/aiQuota summaries
//   GET /api/admin/users/[id]/activity → ProductEvent history (پنجره‌ی bounded)
//   GET /api/admin/users/[id]/ai-usage → quota + usage events (period ثابت MONTHLY سرور)
//   GET /api/admin/users/[id]/errors   → ErrorLog (بدون stack — قرارداد سرور)
//
// - read-only مطلق: هیچ control برای role/plan/quota/password/user وجود ندارد.
// - 404 → صفحه‌ی «یافت نشد»؛ 401/403 → دروازه‌ی دسترسی UX.
// - privacy: فقط فیلدهای allowlist DTO؛ emailMasked همان مقدار سرور است.

import Link from "next/link"
import { useParams } from "next/navigation"
import { useCallback, useMemo } from "react"
import { Activity, ArrowRight, Bot, CreditCard, ShieldAlert } from "lucide-react"
import {
    fetchAdminUserActivity,
    fetchAdminUserAiUsage,
    fetchAdminUserDetail,
    fetchAdminUserErrors,
} from "@/app/lib/admin/adminClient"
import { useAdminQuery } from "@/app/lib/admin/useAdminQuery"
import {
    buildActivityPageVM,
    buildAiUsagePageVM,
    buildPerUserQueryString,
    buildUserDetailVM,
    entitlementStatusLabel,
    faDigits,
    formatTimestamp,
    formatUtilization,
    paymentStatusLabel,
    planLabel,
    resolveListStatus,
    roleLabel,
} from "@/app/lib/admin/adminViewModels"
import {
    AdminAccessGate,
    AdminEmpty,
    AdminErrorState,
    AdminLoading,
    SeverityChip,
} from "../../AdminUi"
import styles from "../../admin.module.css"

const PER_USER_LIMIT = 10

export default function AdminUserDetailPage() {
    const params = useParams<{ id: string }>()
    const userId = typeof params?.id === "string" ? params.id : ""

    // اعتبارسنجی نمایشی id — امنیت واقعی همچنان پارس server-side است
    const idValid = /^\d+$/.test(userId)

    const detailFetcher = useCallback(
        (signal: AbortSignal) => fetchAdminUserDetail(userId, signal),
        [userId],
    )
    const activityQuery = useMemo(
        () => buildPerUserQueryString({}, 1, PER_USER_LIMIT),
        [],
    )
    const activityFetcher = useCallback(
        (signal: AbortSignal) => fetchAdminUserActivity(userId, activityQuery, signal),
        [userId, activityQuery],
    )
    const aiQuery = useMemo(() => buildPerUserQueryString({}, 1, PER_USER_LIMIT), [])
    const aiFetcher = useCallback(
        (signal: AbortSignal) => fetchAdminUserAiUsage(userId, aiQuery, signal),
        [userId, aiQuery],
    )
    const errorsQuery = useMemo(() => buildPerUserQueryString({}, 1, PER_USER_LIMIT), [])
    const errorsFetcher = useCallback(
        (signal: AbortSignal) => fetchAdminUserErrors(userId, errorsQuery, signal),
        [userId, errorsQuery],
    )

    const detail = useAdminQuery(idValid ? `user:${userId}` : "", detailFetcher)
    const activity = useAdminQuery(idValid ? `activity:${userId}` : "", activityFetcher)
    const aiUsage = useAdminQuery(idValid ? "ai-usage" : "", aiFetcher)
    const errors = useAdminQuery(idValid ? "errors" : "", errorsFetcher)

    if (!idValid) {
        return (
            <div className={styles.page}>
                <BackNav />
                <AdminEmpty message="شناسه‌ی کاربر نامعتبر است." />
            </div>
        )
    }

    // 404 → «یافت نشد»؛ 401/403 → دروازه‌ی دسترسی UX
    if (detail.error !== null && detail.error.status === 404) {
        return (
            <div className={styles.page}>
                <BackNav />
                <AdminEmpty message="کاربری با این شناسه پیدا نشد." />
            </div>
        )
    }
    if (detail.error !== null && (detail.error.status === 401 || detail.error.status === 403)) {
        return (
            <div className={styles.page}>
                <BackNav />
                <AdminAccessGate error={`${detail.error.status} ${detail.error.code}`} loading={false} />
            </div>
        )
    }

    if (detail.loading && detail.data === null) {
        return (
            <div className={styles.page}>
                <BackNav />
                <AdminLoading label="در حال دریافت جزئیات کاربر…" />
            </div>
        )
    }
    if (detail.error !== null) {
        return (
            <div className={styles.page}>
                <BackNav />
                <AdminErrorState message={detail.error.message} onRetry={detail.refetch} />
            </div>
        )
    }

    const vm = buildUserDetailVM(detail.data)
    if (vm.user === null) {
        return (
            <div className={styles.page}>
                <BackNav />
                <AdminEmpty message="کاربری با این شناسه پیدا نشد." />
            </div>
        )
    }

    const activityVM = buildActivityPageVM(activity.data, activity.loading && activity.data === null, activity.error === null ? null : (activity.error?.message ?? null))
    const aiVM = buildAiUsagePageVM(aiUsage.data, aiUsage.loading && aiUsage.data === null, aiUsage.error === null ? null : (aiUsage.error?.message ?? null))
    // فاز ۵ §۲۴ — بخش مستقل و read-only؛ null یعنی widget در دسترس نیست (جعل داده ممنوع)
    const billing = vm.billingSummary

    return (
        <div className={styles.page}>
            <BackNav />

            {/* safe identity */}
            <section aria-labelledby="admin-identity-heading" className={styles.section}>
                <h2 id="admin-identity-heading" className={styles.sectionTitle}>
                    پروفایل کاربر
                </h2>
                <div className={styles.identityRow}>
                    <span className={styles.identityName}>{vm.user.username}</span>
                    <span className={styles.identityMeta}>شناسه‌ی {faDigits(vm.user.id)}</span>
                    <span className={`${styles.chip} ${vm.user.role === "ADMIN" ? styles.chipRoleAdmin : ""}`}>
                        {roleLabel(vm.user.role)}
                    </span>
                    <span className={`${styles.chip} ${vm.user.plan === "PRO" ? styles.chipPlanPro : ""}`}>
                        {planLabel(vm.user.plan)}
                    </span>
                </div>
                <dl className={styles.defList}>
                    <dt>ایمیل (ماسک‌شده)</dt>
                    <dd dir="ltr" className={styles.mono}>{vm.user.emailMasked}</dd>
                    <dt>منطقه‌ی زمانی</dt>
                    <dd dir="ltr" className={styles.mono}>{vm.user.timezone}</dd>
                    <dt>آخرین فعالیت</dt>
                    <dd>{formatTimestamp(vm.user.lastSeenAt)}</dd>
                </dl>
            </section>

            {/* activity summary */}
            {vm.activitySummary !== null && (
                <section aria-labelledby="admin-uactivity-heading" className={styles.section}>
                    <h2 id="admin-uactivity-heading" className={styles.sectionTitle}>
                        <Activity size={16} aria-hidden="true" /> خلاصه‌ی فعالیت {faDigits(vm.activitySummary.windowHours)} ساعت اخیر
                    </h2>
                    {vm.activitySummary.byEventName.length === 0 ? (
                        <AdminEmpty message="رویداد فعالیتی در این بازه ثبت نشده است." />
                    ) : (
                        <>
                            <p className={styles.statHint}>مجموع رویدادها: {faDigits(vm.activitySummary.totalEvents)}</p>
                            <div className={styles.countList}>
                                {vm.activitySummary.byEventName.slice(0, 8).map((row) => (
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

            {/* AI usage / quota — null یعنی widget در دسترس نیست (جعل داده ممنوع) */}
            {vm.aiQuotaSummary !== null && (
                <section aria-labelledby="admin-uai-heading" className={styles.section}>
                    <h2 id="admin-uai-heading" className={styles.sectionTitle}>
                        <Bot size={16} aria-hidden="true" /> سهمیه و مصرف AI
                    </h2>
                    <dl className={styles.defList}>
                        <dt>طرح</dt>
                        <dd>{planLabel(vm.aiQuotaSummary.plan)}</dd>
                        <dt>شروع دوره</dt>
                        <dd>{formatTimestamp(vm.aiQuotaSummary.periodStart)}</dd>
                        <dt>سهمیه‌ی مجاز</dt>
                        <dd>{faDigits(vm.aiQuotaSummary.allowedUnits)}</dd>
                        <dt>رزرو / مصرف</dt>
                        <dd>
                            {faDigits(vm.aiQuotaSummary.reservedUnits)} / {faDigits(vm.aiQuotaSummary.consumedUnits)}
                        </dd>
                    </dl>
                    <div
                        className={styles.barTrack}
                        role="img"
                        aria-label={`مصرف ${formatUtilization(vm.aiQuotaSummary.utilization)} از سهمیه`}
                    >
                        <div
                            className={styles.barFill}
                            style={{ width: `${Math.min(100, Math.round(vm.aiQuotaSummary.utilization * 100))}%` }}
                        />
                    </div>
                    <p className={styles.statHint}>مصرف: {formatUtilization(vm.aiQuotaSummary.utilization)}</p>
                </section>
            )}

            {/* اشتراک و پرداخت — read-only (فاز ۵ §۲۴/§۳۰) */}
            {billing !== null && (
                <section aria-labelledby="admin-ubilling-heading" className={styles.section}>
                    <h2 id="admin-ubilling-heading" className={styles.sectionTitle}>
                        <CreditCard size={16} aria-hidden="true" /> اشتراک و پرداخت
                    </h2>
                    <dl className={styles.defList}>
                        <dt>طرح</dt>
                        <dd>{planLabel(billing.plan)}</dd>
                        {billing.entitlement === null ? (
                            <>
                                <dt>وضعیت اشتراک</dt>
                                <dd className={styles.emptyCell}>اشتراکی برای این کاربر ثبت نشده است.</dd>
                            </>
                        ) : (
                            <>
                                <dt>وضعیت اشتراک</dt>
                                <dd>
                                    <span className={styles.chip}>
                                        {entitlementStatusLabel(billing.entitlement.status)}
                                    </span>
                                    <span className={styles.identityMeta}> — {billing.entitlement.provider}</span>
                                </dd>
                                <dt>شروع دوره</dt>
                                <dd>{formatTimestamp(billing.entitlement.currentPeriodStart)}</dd>
                                <dt>پایان دوره</dt>
                                <dd>{formatTimestamp(billing.entitlement.currentPeriodEnd)}</dd>
                            </>
                        )}
                        <dt>آخرین پرداخت</dt>
                        <dd>
                            {billing.latestPayment === null
                                ? "سفارش پرداختی ثبت نشده است."
                                : `${paymentStatusLabel(billing.latestPayment.status)} — ${faDigits(billing.latestPayment.amount)} ${billing.latestPayment.currency} — ${formatTimestamp(billing.latestPayment.createdAt)}`}
                        </dd>
                        {billing.latestPayment !== null && billing.latestPayment.providerReferenceMasked !== null && (
                            <>
                                <dt>شناسه‌ی درگاه (ماسک‌شده)</dt>
                                <dd dir="ltr" className={styles.mono}>
                                    {billing.latestPayment.providerReferenceMasked}
                                </dd>
                            </>
                        )}
                    </dl>
                    <p className={styles.statHint}>
                        فقط خواندن — هیچ شناسه‌ی خام درگاه، هیچ مقدار پرداختی و هیچ تغییر طرحی در این پنل وجود ندارد.
                    </p>
                </section>
            )}

            {/* history رویدادها */}
            <section aria-labelledby="admin-uevents-heading" className={styles.section}>
                <h2 id="admin-uevents-heading" className={styles.sectionTitle}>
                    رویدادهای اخیر
                </h2>
                {activityVM.status === "loading" && <AdminLoading label="در حال دریافت رویدادها…" />}
                {activityVM.status === "empty" && <AdminEmpty message="رویدادی ثبت نشده است." />}
                {activityVM.status === "error" && (
                    <AdminErrorState message={activity.error?.message ?? "خطای ناشناخته"} onRetry={activity.refetch} />
                )}
                {activityVM.status === "data" && (
                    <ul className={styles.countList}>
                        {activityVM.items.map((event) => (
                            <li key={event.id} className={styles.countRow}>
                                <span>
                                    {event.eventName}
                                    {event.feature !== null && <span className={styles.identityMeta}> — {event.feature}</span>}
                                </span>
                                <span>{formatTimestamp(event.createdAt)}</span>
                            </li>
                        ))}
                    </ul>
                )}
            </section>

            {/* تاریخچه‌ی AI usage events — read-only */}
            <section aria-labelledby="admin-uaievents-heading" className={styles.section}>
                <h2 id="admin-uaievents-heading" className={styles.sectionTitle}>
                    رخدادهای اخیر مصرف AI
                </h2>
                {aiVM.status === "loading" && <AdminLoading label="در حال دریافت رخدادها…" />}
                {aiVM.status === "empty" && <AdminEmpty message="رخدادی برای مصرف AI ثبت نشده است." />}
                {aiVM.status === "error" && (
                    <AdminErrorState message={aiUsage.error?.message ?? "خطای ناشناخته"} onRetry={aiUsage.refetch} />
                )}
                {aiVM.status === "data" && (
                    <ul className={styles.countList}>
                        {aiVM.items.map((event) => (
                            <li key={String(event.id)} className={styles.countRow}>
                                <span>
                                    {event.feature}
                                    {event.model !== null && <span className={styles.identityMeta}> — {event.model}</span>}
                                    <span className={styles.identityMeta}> ({event.status})</span>
                                </span>
                                <span>
                                    {faDigits(event.units)} واحد — {formatTimestamp(event.createdAt)}
                                </span>
                            </li>
                        ))}
                    </ul>
                )}
                <p className={styles.statHint}>
                    فقط شمارش واحد — محتوای prompt/response هرگز نمایش داده نمی‌شود.
                </p>
            </section>

            {/* تاریخچه‌ی خطاها */}
            <section aria-labelledby="admin-uerrors-heading" className={styles.section}>
                <h2 id="admin-uerrors-heading" className={styles.sectionTitle}>
                    <ShieldAlert size={16} aria-hidden="true" /> خطاهای اخیر کاربر
                </h2>
                {(() => {
                    const status = resolveListStatus(
                        errors.loading && errors.data === null,
                        errors.error === null ? null : (errors.error?.message ?? null),
                        errors.data === null ? 0 : errors.data.items.length,
                    )
                    if (status === "loading") return <AdminLoading label="در حال دریافت خطاها…" />
                    if (status === "empty") return <AdminEmpty message="خطایی در پنجره‌ی اخیر ثبت نشده است." />
                    if (status === "error")
                        return <AdminErrorState message={errors.error?.message ?? "خطای ناشناخته"} onRetry={errors.refetch} />
                    return (
                        <ul className={styles.countList}>
                            {(errors.data?.items ?? []).map((log) => (
                                <li key={log.id} className={styles.cardItem}>
                                    <div className={styles.cardItemTop}>
                                        <SeverityChip severity={log.severity} />
                                        <span className={styles.mono}>{log.errorCode}</span>
                                    </div>
                                    <div className={styles.cardItemMeta} dir="ltr">
                                        {log.endpoint} {log.statusCode > 0 ? `· HTTP ${log.statusCode}` : ""}
                                    </div>
                                    <div className={styles.cardItemMsg}>{log.message}</div>
                                    <div className={styles.cardItemMeta}>{formatTimestamp(log.createdAt)}</div>
                                </li>
                            ))}
                        </ul>
                    )
                })()}
            </section>
        </div>
    )
}

function BackNav() {
    return (
        <header className={styles.pageHead}>
            <Link href="/admin/users" className={styles.rowLink}>
                <ArrowRight size={14} aria-hidden="true" /> بازگشت به فهرست کاربران
            </Link>
        </header>
    )
}
