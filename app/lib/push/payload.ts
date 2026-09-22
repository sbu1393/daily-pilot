import { z } from "zod"

// ADR-07 / Phase 3-A — ساختار payload اعلان Web Push.
// حداقلی و بدون داده‌ی حساس: فقط taskId و متن/مسیر — هیچ secret، توکن یا کلید VAPID.

export const TASK_REMINDER_TYPE = "task-reminder" as const

export const taskReminderPayloadSchema = z.object({
    type: z.literal(TASK_REMINDER_TYPE),
    taskId: z.union([z.number().int().positive(), z.string().trim().min(1).max(128)]),
    title: z.string().trim().min(1).max(200),
    body: z.string().max(500),
    // مسیر داخلی اپ — هرگز URL خارجی (جلوگیری از open redirect در notificationclick)
    url: z
        .string()
        .trim()
        .min(1)
        .max(2048)
        .refine((u) => u.startsWith("/"), "url must be an internal path"),
})

export type TaskReminderPayload = z.infer<typeof taskReminderPayloadSchema>

/** ساخت payload استاندارد از ورودی دامنه (بدون داده‌ی حساس). */
export function buildTaskReminderPayload(input: {
    taskId: number | string
    title: string
    body?: string
    url?: string
}): TaskReminderPayload {
    return {
        type: TASK_REMINDER_TYPE,
        taskId: input.taskId,
        title: input.title,
        body: input.body ?? "",
        url: input.url ?? "/dashboard",
    }
}
