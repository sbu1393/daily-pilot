import { describe, expect, it } from "vitest"
import { buildTaskReminderPayload, taskReminderPayloadSchema } from "./payload"

const valid = {
    type: "task-reminder",
    taskId: 42,
    title: "تماس با مشتری",
    body: "وقتشه!",
    url: "/dashboard?taskId=42",
}

describe("taskReminderPayloadSchema", () => {
    it("accepts a valid payload", () => {
        expect(taskReminderPayloadSchema.safeParse(valid).success).toBe(true)
    })

    it("accepts a string taskId", () => {
        expect(taskReminderPayloadSchema.safeParse({ ...valid, taskId: "local-123" }).success).toBe(true)
    })

    it.each([
        ["wrong type", { ...valid, type: "other" }],
        ["empty title", { ...valid, title: "" }],
        ["missing url", { type: "task-reminder", taskId: 1, title: "a", body: "" }],
        ["external url", { ...valid, url: "https://evil.example.com" }],
        ["negative taskId", { ...valid, taskId: -1 }],
        ["non-object", "nope"],
        ["missing body", { type: "task-reminder", taskId: 1, title: "a", url: "/x" }],
    ])("rejects %s", (_label, payload) => {
        expect(taskReminderPayloadSchema.safeParse(payload).success).toBe(false)
    })
})

describe("buildTaskReminderPayload", () => {
    it("fills safe defaults for body and url", () => {
        expect(buildTaskReminderPayload({ taskId: 7, title: "کار" })).toEqual({
            type: "task-reminder",
            taskId: 7,
            title: "کار",
            body: "",
            url: "/dashboard",
        })
    })

    it("keeps a provided body and internal url", () => {
        const payload = buildTaskReminderPayload({
            taskId: 7,
            title: "کار",
            body: "یادت نره",
            url: "/dashboard?taskId=7",
        })

        expect(payload.body).toBe("یادت نره")
        expect(payload.url).toBe("/dashboard?taskId=7")
        expect(taskReminderPayloadSchema.safeParse(payload).success).toBe(true)
    })
})
