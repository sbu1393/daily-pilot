import { api, ApiClientError } from "@/app/lib/api/client"
import type {
    CreateTicketInput,
    SendTicketMessageInput,
    TicketDetailView,
    TicketMessagePageView,
    TicketMessageView,
    TicketPage,
    TicketView,
    TicketWithMessagesView,
    UserTicketUpdateInput,
} from "./ticketTypes"

// T5 — لایهٔ دادهٔ تیکت سمت کلاینت (سطح کاربر)
// ---------------------------------------------------------------
// فقط `api<T>()` مرکزی ADR-04 استفاده می‌شود — **هیچ fetch wrapper جدیدی**
// ساخته نمی‌شود (همان تصمیمی که `app/lib/admin/adminClient.ts` گرفته).
// قرارداد خطا: `ApiClientError { status, code, message, errors }`.
//
// این لایه هیچ authorization و هیچ قضاوتی ندارد: endpoint را صدا می‌زند و
// خطای سرور را همان‌طور که هست بالا می‌فرستد.

export interface TicketRequestError {
    status: number
    code: string
    message: string
}

export function toTicketRequestError(error: unknown): TicketRequestError {
    if (error instanceof ApiClientError) {
        return { status: error.status, code: error.code, message: error.message }
    }
    return {
        status: 0,
        code: "NETWORK_ERROR",
        message: error instanceof Error ? error.message : "خطای ناشناخته",
    }
}

function jsonBody(payload: unknown): RequestInit {
    return {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    }
}

// ---------- GET /api/tickets ----------

export async function fetchTickets(query: string, signal?: AbortSignal): Promise<TicketPage> {
    return api<TicketPage>(`/api/tickets?${query}`, { signal })
}

// ---------- POST /api/tickets ----------

export async function createTicket(input: CreateTicketInput): Promise<TicketView> {
    const data = await api<{ ticket: TicketView }>("/api/tickets", {
        method: "POST",
        ...jsonBody(input),
    })
    return data.ticket
}

// ---------- GET /api/tickets/[id] ----------

/**
 * `query` رشتهٔ آمادهٔ `messagesPage`/`messagesLimit` است (از
 * `buildTicketMessagesQuery` می‌آید) — همان الگوی `fetchTickets(query)`.
 * رشتهٔ خالی یعنی «پیش‌فرض سرور»؛ در آن صورت `?` هم اضافه نمی‌شود.
 */
export async function fetchTicket(
    id: number,
    query = "",
    signal?: AbortSignal,
): Promise<TicketDetailView> {
    const suffix = query ? `?${query}` : ""
    const data = await api<{ ticket: TicketWithMessagesView; messagePage: TicketMessagePageView }>(
        `/api/tickets/${id}${suffix}`,
        { signal },
    )
    return { ticket: data.ticket, messagePage: data.messagePage }
}

// ---------- PATCH /api/tickets/[id] ----------

export async function updateTicket(id: number, input: UserTicketUpdateInput): Promise<TicketView> {
    const data = await api<{ ticket: TicketView }>(`/api/tickets/${id}`, {
        method: "PATCH",
        ...jsonBody(input),
    })
    return data.ticket
}

// ---------- POST /api/tickets/[id]/messages ----------

export async function sendTicketMessage(
    id: number,
    input: SendTicketMessageInput,
): Promise<TicketMessageView> {
    const data = await api<{ message: TicketMessageView }>(`/api/tickets/${id}/messages`, {
        method: "POST",
        ...jsonBody(input),
    })
    return data.message
}
