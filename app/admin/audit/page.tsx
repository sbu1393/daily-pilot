"use client"

// Admin V2 — /admin/audit — گزارش فعالیت ادمین (read-only)
//
// منبع داده: GET /api/admin/audit-log (listAdminAuditLogs).
// before/after به‌صورت خلاصه‌ی متنی نمایش داده می‌شوند (projection allowlist سرور)؛
// هیچ JSON خام render نمی‌شود و raw rejected promo code هرگز در snapshot نیست.

import { useCallback, useEffect, useMemo, useState } from "react"
import { ScrollText } from "lucide-react"
import { fetchAdminAuditLogs } from "@/app/lib/admin/adminClient"
import { useAdminQuery } from "@/app/lib/admin/useAdminQuery"
import {
    auditActionLabel,
    auditActorLabel,
    buildAuditLogsPageVM,
    buildAuditQueryString,
    faDigits,
    formatAuditSnapshot,
    formatTimestamp,
} from "@/app/lib/admin/adminViewModels"
import { ADMIN_PAGE_DEFAULT_LIMIT } from "@/app/lib/admin/adminTypes"
import {
    AdminAccessGate,
    AdminEmpty,
    AdminErrorState,
    AdminLoading,
    AdminNavTabs,
    AdminPagination,
} from "../AdminUi"
import styles from "../admin.module.css"

export default function AdminAuditPage() {
    const [action, setAction] = useState("")
    const [targetType, setTargetType] = useState("")
    const [targetId, setTargetId] = useState("")
    const [actorUserId, setActorUserId] = useState("")
    const [page, setPage] = useState(1)

    // پارامترهای لینک‌های عمیق (مثل /admin/audit?targetType=promo_code&targetId=...)
    // فقط سمت کلاینت خوانده می‌شوند تا هیچ وابستگی SSR/Suspense ایجاد نشود.
    useEffect(() => {
        const sp = new URLSearchParams(window.location.search)
        if (sp.get("action") !== null) setAction(sp.get("action") ?? "")
        if (sp.get("targetType") !== null) setTargetType(sp.get("targetType") ?? "")
        if (sp.get("targetId") !== null) setTargetId(sp.get("targetId") ?? "")
        if (sp.get("actorUserId") !== null) setActorUserId(sp.get("actorUserId") ?? "")
    }, [])

    const query = useMemo(
        () =>
            buildAuditQueryString({
                action,
                targetType,
                targetId,
                actorUserId,
                page,
                limit: ADMIN_PAGE_DEFAULT_LIMIT,
            }),
        [action, targetType, targetId, actorUserId, page],
    )

    const fetcher = useCallback((signal: AbortSignal) => fetchAdminAuditLogs(query, signal), [query])
    const { data, loading, error, refetch } = useAdminQuery(query, fetcher)
    const vm = buildAuditLogsPageVM(
        data,
        loading && data === null,
        error === null ? null : error.message,
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

            <div className={styles.filterBar} role="search" aria-label="فیلتر گزارش فعالیت">
                <input
                    type="search"
                    className={`${styles.filterInput} ${styles.filterInputSearch}`}
                    value={action}
                    onChange={(e) => {
                        setAction(e.target.value)
                        setPage(1)
                    }}
                    placeholder="action (مثلاً promo.created)"
                    aria-label="فیلتر action"
                    dir="ltr"
                />
                <input
                    type="text"
                    className={`${styles.filterInput} ${styles.filterInputSearch}`}
                    value={targetType}
                    onChange={(e) => {
                        setTargetType(e.target.value)
                        setPage(1)
                    }}
                    placeholder="targetType"
                    aria-label="فیلتر targetType"
                    dir="ltr"
                />
                <input
                    type="text"
                    className={`${styles.filterInput} ${styles.filterInputSearch}`}
                    value={targetId}
                    onChange={(e) => {
                        setTargetId(e.target.value)
                        setPage(1)
                    }}
                    placeholder="targetId"
                    aria-label="فیلتر targetId"
                    dir="ltr"
                />
                <input
                    type="text"
                    inputMode="numeric"
                    className={styles.filterInput}
                    value={actorUserId}
                    onChange={(e) => {
                        setActorUserId(e.target.value)
                        setPage(1)
                    }}
                    placeholder="شناسه ادمین"
                    aria-label="فیلتر شناسه ادمین"
                />
            </div>

            {vm.status === "loading" && <AdminLoading label="در حال دریافت گزارش فعالیت…" />}
            {vm.status === "error" && (
                <AdminErrorState message={error?.message ?? "خطای ناشناخته"} onRetry={refetch} />
            )}
            {vm.status === "empty" && <AdminEmpty message="رویدادی با این فیلترها ثبت نشده است." />}

            {vm.status === "data" && (
                <section aria-label="گزارش فعالیت" className={styles.section}>
                    <p className={styles.statHint}>{faDigits(vm.total)} رویداد</p>

                    <div className={styles.tableScroll}>
                        <table className={styles.table}>
                            <thead>
                                <tr>
                                    <th scope="col">زمان</th>
                                    <th scope="col">ادمین</th>
                                    <th scope="col">اقدام</th>
                                    <th scope="col">هدف</th>
                                    <th scope="col">قبل → بعد</th>
                                    <th scope="col">correlation</th>
                                </tr>
                            </thead>
                            <tbody>
                                {vm.items.map((log) => (
                                    <tr key={log.id}>
                                        <td>{formatTimestamp(log.createdAt)}</td>
                                        <td>{auditActorLabel(log)}</td>
                                        <td title={log.action}>{auditActionLabel(log.action)}</td>
                                        <td className={styles.mono} dir="ltr">
                                            {log.targetType}:{log.targetId}
                                        </td>
                                        <td className={styles.cardItemMsg}>
                                            {formatAuditSnapshot(log.before)} → {formatAuditSnapshot(log.after)}
                                        </td>
                                        <td className={styles.mono} dir="ltr">
                                            {log.requestId ?? "—"}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>

                    <ul className={styles.cardList}>
                        {vm.items.map((log) => (
                            <li key={log.id} className={styles.cardItem}>
                                <div className={styles.cardItemTop}>
                                    <span className={styles.cardItemTitle}>{auditActionLabel(log.action)}</span>
                                    <span className={styles.cardItemMeta}>
                                        {formatTimestamp(log.createdAt)}
                                    </span>
                                </div>
                                <div className={styles.cardItemMeta}>
                                    ادمین: {auditActorLabel(log)} · {log.targetType}:{log.targetId}
                                </div>
                                <div className={styles.cardItemMsg}>
                                    {formatAuditSnapshot(log.before)} → {formatAuditSnapshot(log.after)}
                                </div>
                            </li>
                        ))}
                    </ul>

                    <AdminPagination
                        page={vm.page}
                        totalPages={vm.totalPages}
                        hasPrev={vm.hasPrev}
                        hasNext={vm.hasNext}
                        onPrev={() => setPage((p) => Math.max(1, p - 1))}
                        onNext={() => setPage((p) => p + 1)}
                    />
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
                    <ScrollText size={18} aria-hidden="true" style={{ verticalAlign: "-3px" }} /> گزارش فعالیت
                </h1>
                <p className={styles.pageSub}>
                    گزارش read-only عملیات ادمین — با خلاصه‌ی before/after و بدون داده‌ی حساس.
                </p>
            </div>
            <div className={styles.headSpacer} />
            <AdminNavTabs active="/admin/audit" />
        </header>
    )
}
