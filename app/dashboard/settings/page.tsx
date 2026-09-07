import { getCurrentUser } from "@/app/lib/getCurrentUser"
import { redirect } from "next/navigation"
import SettingsPanel from "./SettingsPanel"

export default async function SettingsPage() {
    const user = await getCurrentUser()
    if (!user) redirect("/auth/login")

    return <SettingsPanel user={user} />
}