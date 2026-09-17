// فاز ۴ — Step 7: لایه‌ی داده‌ی Admin سمت کلاینت
//
// قراردادها:
// - فقط GET (read-only)؛ هیچ mutation وجود ندارد.
// - همان api<T>() مرکزی ADR-04 (client.ts) استفاده می‌شود — لایه‌ی fetch جدید نساخته نمی‌شود.
// - ApiClientError → { status, code, message } تا UI بتواند 401/403/404 را تفکیک کند.
// - AbortSignal همان الگوی useDaySuggestion پاس داده می‌شود (الگوی رسمی repo).

import { api, ApiClientError } from "@/app/lib/api/client"
import type {
    AdminActivityPage,
    AdminAiUsagePage,
    AdminErrorLogsPage,
    AdminOverview,
    AdminUserDetail,
    AdminUsersPage,
} from "./adminTypes"

export interface AdminRequestError {
    status: number
    code: string
    message: string
}

export function toAdminRequestError(error: unknown): AdminRequestError {
    if (error instanceof ApiClientError) {
        return { status: error.status, code: error.code, message: error.message }
    }
    return {
        status: 0,
        code: "NETWORK_ERROR",
        message: error instanceof Error ? error.message : "خطای ناشناخته",
    }
}

/** پیام نمایشی خطا — فقط message امن envelope؛ هیچ جزئیات فنی خام. */
export function toAdminErrorMessage(error: unknown): string {
    if (error instanceof ApiClientError) return error.message
    return error instanceof Error ? error.message : "خطای ناشناخته"
}

// ---------- /admin (overview) ----------

export async function fetchAdminOverview(signal?: AbortSignal): Promise<AdminOverview> {
    return api<AdminOverview>("/api/admin/overview", { signal })
}

// ---------- /admin/users ----------

export async function fetchAdminUsers(query: string, signal?: AbortSignal): Promise<AdminUsersPage> {
    return api<AdminUsersPage>(`/api/admin/users?${query}`, { signal })
}

// ---------- /admin/users/[id] ----------

export async function fetchAdminUserDetail(id: string, signal?: AbortSignal): Promise<AdminUserDetail> {
    return api<AdminUserDetail>(`/api/admin/users/${encodeURIComponent(id)}`, { signal })
}

export async function fetchAdminUserActivity(
    id: string,
    query: string,
    signal?: AbortSignal,
): Promise<AdminActivityPage> {
    return api<AdminActivityPage>(`/api/admin/users/${encodeURIComponent(id)}/activity?${query}`, { signal })
}

export async function fetchAdminUserAiUsage(
    id: string,
    query: string,
    signal?: AbortSignal,
): Promise<AdminAiUsagePage> {
    return api<AdminAiUsagePage>(`/api/admin/users/${encodeURIComponent(id)}/ai-usage?${query}`, { signal })
}

export async function fetchAdminUserErrors(
    id: string,
    query: string,
    signal?: AbortSignal,
): Promise<AdminErrorLogsPage> {
    return api<AdminErrorLogsPage>(`/api/admin/users/${encodeURIComponent(id)}/errors?${query}`, { signal })
}

// ---------- /admin/errors ----------

export async function fetchAdminErrors(query: string, signal?: AbortSignal): Promise<AdminErrorLogsPage> {
    return api<AdminErrorLogsPage>(`/api/admin/errors?${query}`, { signal })
}
