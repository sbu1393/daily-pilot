"use client"

import { useCallback, useMemo, useState } from "react"
import Link from "next/link"
import { LifeBuoy, Plus } from "lucide-react"

import { useTicketQuery } from "@/app/hooks/useTicketQuery"
import { fetchTickets } from "@/app/lib/tickets/ticketClient"
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
    PriorityChip,
    StatusChip,
    TicketEmpty,
    TicketErrorBox,
    TicketLoading,
    TicketPager,
} from "./TicketParts"
import styles from "./support.module.css"

/*
 * T5 — /support — فهرست تیکت‌های کاربر
 *
 * منبع داده: GET /api/tickets (صفحه‌بندی و فیلتر status سمت سرور).
 * این صفحه هیچ قضاوتی دربارهٔ مالکیت نمی‌کند — لیست را API برمی‌گرداند و همین
 * است. pagination هم شبیه‌سازیِ سمت کلاینت نیست؛ `page` در query واقعی می‌رود.
 */

const PAGE_LIMIT = 20

export default function SupportListPage() {
    const [status, setStatus] = useState<TicketStatus | "">("")
    const [page, setPage] = useState(1)

    const query = useMemo(() => buildTicketListQuery({ page, limit: PAGE_LIMIT, status }), [page, status])

    const fetcher = useCallback((signal: AbortSignal) => fetchTickets(query, signal), [query])
    const { data, loading, error, refetch } = useTicketQuery(query, fetcher)

    const vmStatus = resolveTicketListStatus(
        loading && data === null,
        error === null ? null : ticketErrorMessage(error),
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
            <header className={styles.pageHead}>
                <div>
                    <h1 className={styles.pageTitle}>
                        <LifeBuoy size={18} aria-hidden="true" style={{ verticalAlign: "-3px" }} /> پشتیبانی
                    </h1>
                    <p className={styles.pageSub}>
                        تیکت‌های ثبت‌شده‌ی شما و پاسخ‌های پشتیبانی.
                    </p>
                </div>
                <div className={styles.headSpacer} />
                <Link href="/support/new" className="dp-btn dp-btn-primary">
                    <Plus size={16} aria-hidden="true" /> تیکت جدید
                </Link>
            </header>

            <div className={styles.card} role="search" aria-label="فیلتر وضعیت تیکت">
                <label className="dp-field-label" htmlFor="ticket-status-filter">
                    فیلتر وضعیت
                </label>
                <select
                    id="ticket-status-filter"
                    className="dp-input"
                    value={status}
                    onChange={(e) => {
                        setStatus(e.target.value as TicketStatus | "")
                        setPage(1)
                    }}
                >
                    <option value="">همه</option>
                    {TICKET_STATUS_OPTIONS.map((option) => (
                        <option key={option} value={option}>
                            {TICKET_STATUS_LABELS[option]}
                        </option>
                    ))}
                </select>
            </div>

            {vmStatus === "loading" && <TicketLoading label="در حال دریافت تیکت‌ها…" />}
            {vmStatus === "error" && (
                <TicketErrorBox message={ticketErrorMessage(error)} onRetry={refetch} />
            )}
            {vmStatus === "empty" && (
                <TicketEmpty message="هنوز تیکتی ثبت نکرده‌اید. برای گزارش مشکل یا پرسش، تیکت جدید بسازید." />
            )}

            {vmStatus === "data" && data !== null && (
                <>
                    <ul className={styles.cardList}>
                        {data.items.map((ticket) => {
                            const row = buildTicketRow(ticket)
                            return (
                                <li key={row.id}>
                                    <Link href={`/support/${row.id}`} className={styles.ticketLink}>
                                        <div className={styles.ticketTop}>
                                            <span className={styles.ticketSubject}>{row.subject}</span>
                                            <span className={styles.chipRow}>
                                                <StatusChip status={row.status} label={row.statusLabel} />
                                                <PriorityChip
                                                    priority={row.priority}
                                                    label={row.priorityLabel}
                                                />
                                            </span>
                                        </div>
                                        <div className={styles.ticketMeta}>
                                            <span>{row.categoryLabel}</span>
                                            <span>{row.updatedLabel ?? "—"}</span>
                                        </div>
                                    </Link>
                                </li>
                            )
                        })}
                    </ul>

                    <TicketPager
                        page={pagination.page}
                        pageInfo={`صفحه‌ی ${pagination.page} از ${pagination.totalPages}`}
                        hasPrev={pagination.hasPrev}
                        hasNext={pagination.hasNext}
                        onPrev={() => setPage((p) => Math.max(1, p - 1))}
                        onNext={() => setPage((p) => p + 1)}
                    />
                </>
            )}
        </div>
    )
}
