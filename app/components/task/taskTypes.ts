export type TaskPriority = "HIGH" | "MEDIUM" | "LOW"
export type TaskStatus = "TODO" | "IN_PROGRESS" | "DONE"

export type TaskItem = {
    id: number
    text: string
    category: string | null
    priority: TaskPriority
    score: number | null
    reason: string | null
    status: TaskStatus
    dayKey: string
    estimatedTime: number | null
    allocatedMinutes: number | null
    spentMinutes: number | null
    completedOn: string | null
    createdAt: string
    updatedAt: string
}

export const priorityMeta: Record<TaskPriority, { label: string; color: string; bg: string }> = {
    HIGH: { label: "بالا", color: "#b42318", bg: "#fee4e2" },
    MEDIUM: { label: "متوسط", color: "#b54708", bg: "#fef0c7" },
    LOW: { label: "کم", color: "#175cd3", bg: "#eff8ff" },
}

const categoryMeta: Record<string, { label: string; color: string; bg: string }> = {
    Work: { label: "کاری", color: "#175cd3", bg: "#eff8ff" },
    Personal: { label: "شخصی", color: "#067647", bg: "#ecfdf3" },
    Urgent: { label: "فوری", color: "#b42318", bg: "#fee4e2" },
    Health: { label: "سلامتی", color: "#b54708", bg: "#fef0c7" },
}

export function categoryInfo(category: string | null) {
    if (!category) return { label: "بدون دسته", color: "#475467", bg: "#f2f4f7" }
    return categoryMeta[category] ?? { label: category, color: "#475467", bg: "#f2f4f7" }
}
