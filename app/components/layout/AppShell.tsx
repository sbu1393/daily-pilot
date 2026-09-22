import Header from "../Header"
import Link from "next/link"
import type { AvatarUser } from "../Avatar"
import TaskReminderWatcher from "../task/TaskReminderWatcher"
import MissedReminderReconciler from "../task/MissedReminderReconciler"

function AppShell({
    children,
    user,
}: {
    children: React.ReactNode
    user: AvatarUser | null
}) {
    return (
        <div className="app-bg">
            <TaskReminderWatcher />
            <MissedReminderReconciler />
            <Header user={user} />
            {/* نوار اشتراک: دقیقاً زیر هدر و بالای محتوا (تقویم) */}
            <Link
                href="/subscription"
                className="bg-amber-400 hover:bg-amber-500 text-white font-bold py-2 px-4 rounded-lg shadow-md mx-4 mt-2 mb-4 inline-block"
            >
                ارتقای حساب به ویژه
            </Link>
            <main className="app-container">{children}</main>
        </div>
    )
}

export default AppShell
