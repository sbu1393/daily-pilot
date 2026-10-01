"use client"

import { useCallback, useMemo, useState } from "react"
import Link from "next/link"
import { LifeBuoy } from "lucide-react"

import { fetchAdminTickets } from "@/app/lib/admin/adminClient"
import { useAdminQuery } from "@/app/lib/admin/useAdminQuery"
import {
    TICKET_STATUS_LABELS,
    TICKET_STATUS_OPTIONS,
    buildTicketListQuery,
    buildTicketPagination,
    buildTicketRow,
    resolveTicketListStatus,
    ticketErrorMessage,
} from "@/app/lib/tickets/ticketViewModels"
import type { TicketStatus } from "@/app/lib/tickets/ticketTypes"
import {
    AdminAccessGate,
    AdminEmpty,
    AdminErrorState,
    AdminLoading,
    AdminNavTabs,
    AdminPagination,
} from "../AdminUi"
import styles from "../admin.module.css"

/*
 * T5 — /admin/tickets — صف پشتیبانی (نمای کارمند)
 *
 * منبع داده: GET /api/admin/tickets — **همیشه** از مسیر admin. صفحه‌بندی و فیلتر
 * status همان قراردادی است که API می‌دهد و شبیه‌سازی نمی‌شود.
 *
 * این صفحه هیچ business rule ندارد: قوانین وضعیت/اولویت/دسترسی در سرویس و
 * `requireAdmin` enforce می‌شوند. `AdminAccessGate` هم فقط UX است (به‌صراحت در
 * خودِ AdminUi نوشته شده).
 */

const PAGE_LIMIT = 20

export default function AdminTicketsPage() {
    const [status, setStatus] = useState<TicketStatus | "">("")
    const [page, setPage] = useState(1)

    const query = useMemo(() => buildTicketListQuery({ page, limit: PAGE_LIMIT, status }), [page, status])

    const fetcher = useCallback((signal: AbortSignal) => fetchAdminTickets(query, signal), [query])
    const { data, loading, error, refetch } = useAdminQuery(query, fetcher)

    if (error !== null && (error.status === 401 || error.status === 403)) {
        return (
            <div className={styles.page}>
                <PageHead />
                <AdminAccessGate error={`${error.status} ${error.code}`} loading={false} />
            </div>
        )
    }

    const vmStatus = resolveTicketListStatus(
        loading && data === null,
        error === null ? null : error.message,
        data?.items.length ?? 0,
    )
    const pagination = buildTicketPagination(
        data?.page ?? page,
        data?.limit ?? PAGE_LIMIT,
        data?.total ?? 0,
        data?.hasMore ?? false,
    )

    return (
        <div className={styles.page}>
            <PageHead />

            <div className={styles.filterBar} role="search" aria-label="فیلتر صف تیکت">
                <select
                    className={styles.filterSelect}
                    value={status}
                    aria-label="فیلتر وضعیت تیکت"
                    onChange={(e) => {
                        setStatus(e.target.value as TicketStatus | "")
                        setPage(1)
                    }}
                >
                    <option value="">همهٔ وضعیت‌ها</option>
                    {TICKET_STATUS_OPTIONS.map((option) => (
                        <option key={option} value={option}>
                            {TICKET_STATUS_LABELS[option]}
                        </option>
                    ))}
                </select>
            </div>

            {vmStatus === "loading" && <AdminLoading label="در حال دریافت صف تیکت‌ها…" />}
            {vmStatus === "error" && <AdminErrorState message={ticketErrorMessage(error)} onRetry={refetch} />}
            {vmStatus === "empty" && <AdminEmpty message="تیکتی با این فیلتر وجود ندارد." />}

            {vmStatus === "data" && data !== null && (
                <section aria-label="صف تیکت‌ها" className={styles.section}>
                    <p className={styles.statHint}>
                        {data.total} تیکت — تازه‌به‌روزشده‌ها اول
                    </p>

                    <div className={styles.tableScroll}>
                        <table className={styles.table}>
                            <thead>
                                <tr>
                                    <th scope="col">موضوع</th>
                                    <th scope="col">کاربر</th>
                                    <th scope="col">وضعیت</th>
                                    <th scope="col">اولویت</th>
                                    <th scope="col">دسته</th>
                                    <th scope="col">آخرین فعالیت</th>
                                </tr>
                            </thead>
                            <tbody>
                                {data.items.map((ticket) => {
                                    const row = buildTicketRow(ticket)
                                    return (
                                        <tr key={row.id}>
                                            <td>
                                                <Link href={`/admin/tickets/${row.id}`} className={styles.rowLink}>
                                                    {row.subject}
                                                </Link>
                                            </td>
                                            <td className={styles.mono} dir="ltr">
                                                {ticket.userId}
                                            </td>
                                            <td>
                                                <span className={styles.chip}>{row.statusLabel}</span>
                                            </td>
                                            <td>
                                                <span
                                                    className={`${styles.chip} ${
                                                        row.priority === "URGENT" ? styles.chipCritical : ""
                                                    }`}
                                                >
                                                    {row.priorityLabel}
                                                </span>
                                            </td>
                                            <td>{row.categoryLabel}</td>
                                            <td>{row.updatedLabel ?? "—"}</td>
                                        </tr>
                                    )
                                })}
                            </tbody>
                        </table>
                    </div>

                    <AdminPagination
                        page={pagination.page}
                        totalPages={pagination.totalPages}
                        hasPrev={pagination.hasPrev}
                        hasNext={pagination.hasNext}
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
                    <LifeBuoy size={18} aria-hidden="true" style={{ verticalAlign: "-3px" }} /> صف تیکت‌ها
                </h1>
                <p className={styles.pageSub}>
                    تیکت‌های پشتیبانی کاربران — پاسخ و تغییر وضعیت از صفحه‌ی جزئیات.
                </p>
            </div>
            <div className={styles.headSpacer} />
            <AdminNavTabs active="/admin/tickets" />
        </header>
    )
}
