// T5 — Ticket UI: لایهٔ DTO سمت کلاینت
// ---------------------------------------------------------------
// این تایپ‌ها **آینهٔ** قرارداد API فاز T4 هستند (همان کاری که
// `app/lib/admin/adminTypes.ts` برای پنل مدیریت می‌کند):
//   موفقیت { ok, data }  ·  خطا { ok:false, error:{ code, message } }
//
// چرا string و نه Date؟ پاسخ HTTP از `NextResponse.json` می‌آید، پس تاریخ‌ها
// ISO string هستند. فرمت‌کردنشان کارِ لایهٔ view-model است، نه لایهٔ داده.
//
// نکتهٔ امنیتی: اینجا فقط **خواندن** تعریف شده. هیچ نوعی برای `role`/`userId`
// ورودی وجود ندارد، چون UI هرگز این‌ها را ارسال نمی‌کند — و T2 با `.strict()`
// هم آن‌ها را رد می‌کند.

export type TicketStatus = "OPEN" | "PENDING" | "CLOSED"
export type TicketPriority = "LOW" | "MEDIUM" | "HIGH" | "URGENT"
export type TicketCategoryKey = "bug" | "billing" | "account" | "feature" | "question" | "other"

export interface TicketView {
    id: number
    userId: number
    subject: string
    status: TicketStatus
    priority: TicketPriority
    category: string | null
    lastMessageAt: string | null
    closedAt: string | null
    createdAt: string
    updatedAt: string
}

export interface TicketMessageView {
    id: string
    ticketId: number
    authorUserId: number
    body: string
    /** snapshot نقش نویسنده در لحظهٔ نوشتن (سمت سرور تعیین شده، نه کلاینت). */
    isStaff: boolean
    createdAt: string
}

export interface TicketWithMessagesView extends TicketView {
    /** فقط پیام‌های صفحهٔ جاری — کل گفتگو دیگر یک‌جا برنمی‌گردد (R1). */
    messages: TicketMessageView[]
}

/**
 * متادیتای صفحه‌بندی گفتگو (شکلِ آینهٔ `TicketListResult` سمت سرور).
 * `total` کلِ پیام‌های تیکت است، نه کلِ صفحهٔ جاری.
 */
export interface TicketMessagePageView {
    page: number
    limit: number
    total: number
    hasMore: boolean
}

/** پاسخ `GET /api/tickets/[id]` و `GET /api/admin/tickets/[id]`. */
export interface TicketDetailView {
    ticket: TicketWithMessagesView
    messagePage: TicketMessagePageView
}

export interface TicketPage {
    items: TicketView[]
    page: number
    limit: number
    total: number
    hasMore: boolean
}

// ---------- ورودی‌ها ----------
// این‌ها **allowlist** هستند: تنها فیلدهایی که UI اجازهٔ ارسالشان را دارد.
// هیچ‌کدام شامل `userId`/`authorUserId`/`isStaff`/`ticketId`/`closedAt`/
// `assignedToUserId`/`role` نیستند — نه به‌عنوان فیلد، نه به‌عنوان optional.

/** ورودی فرم ایجاد تیکت (کاربر). */
export interface CreateTicketInput {
    subject: string
    body: string
    category?: TicketCategoryKey
    priority?: TicketPriority
}

/** ورودی ویرایش تیکت توسط کاربر — فقط چیزی که API کاربر اجازه می‌دهد. */
export interface UserTicketUpdateInput {
    priority?: TicketPriority
    category?: TicketCategoryKey | null
}

/** ورودی ویرایش تیکت توسط کارمند — شامل status و اولویت کامل (URGENT). */
export interface StaffTicketUpdateInput {
    status?: TicketStatus
    priority?: TicketPriority
    category?: TicketCategoryKey | null
}

export interface SendTicketMessageInput {
    body: string
}
