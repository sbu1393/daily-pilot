import Header from "../Header"
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
            <main className="app-container">{children}</main>
        </div>
    )
}

export default AppShell