import Header from "@/app/components/Header"
import Hero from "@/app/components/landing/Hero"
import DashboardPreview from "@/app/components/landing/DashboardPreview"
import Features from "@/app/components/landing/Features"
import DownloadSection from "@/app/components/landing/DownloadSection"
import CTASection from "@/app/components/landing/CTASection"
import { getCurrentUser } from "@/app/lib/getCurrentUser"
import type { AvatarUser } from "@/app/components/Avatar"
import styles from "@/app/components/landing/landing.module.css"

// نشست کاربر فقط «یک بار» در سطح صفحه خوانده می‌شود و با Props به
// هدر و بخش‌های لندینگ منتقل می‌شود (الگوی Container + Composition).
// این‌طوری به‌جای دو کوئری، فقط یک کوئری دیتابیس در هر بازدید داریم.
async function getLandingUser(): Promise<AvatarUser | null> {
    try {
        return await getCurrentUser()
    } catch {
        return null
    }
}

export default async function Home() {
    const user = await getLandingUser()

    return (
        <main className={styles.landingPage}>
            <Header user={user} />
            <Hero user={user} />
            <DashboardPreview />
            <Features />
            <DownloadSection />
            <CTASection user={user} />
        </main>
    )
}
