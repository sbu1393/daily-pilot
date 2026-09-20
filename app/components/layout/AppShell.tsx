import Header from "../Header"
import Link from "next/link"
import { Sparkles } from "lucide-react"
import type { AvatarUser } from "../Avatar"

function AppShell({
    children,
    user,
}: {
    children: React.ReactNode
    user: AvatarUser | null
}) {
    return (
        <div className="app-bg">
            <Header user={user} />
            {/* نوار اشتراک: دقیقاً زیر هدر و بالای محتوا (تقویم) */}
            <div className="app-upgrade-bar">
                <Link href="/subscription" className="dp-btn dp-btn-premium">
                    <Sparkles size={16} aria-hidden="true" />
                    ارتقای حساب به ویژه
                </Link>
            </div>
            <main className="app-container">{children}</main>
        </div>
    )
}

export default AppShell
