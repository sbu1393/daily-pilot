import type { Metadata } from "next"
import localFont from "next/font/local"
import "./globals.css"
import "react-toastify/dist/ReactToastify.css"
import { CalendarProvider } from "./contexts/CalenderContext"
import { SettingsProvider } from "./contexts/SettingsContext"
import PwaRegister from "./components/PwaRegister"
import OfflineIndicator from "./components/OfflineIndicator"
// «تنظیم زمان» — یادآوری تسک + آلارم صوتی (کاملاً additive؛ فقط localStorage)
import { ReminderProvider } from "./hooks/useTaskReminder"
import Splash from "./components/Splash"
import { ToastContainer } from "react-toastify"

/**
 * فونت وزیرمتن سلف‌هاست‌شده (نسخه رسمی v33.003).
 *
 * چرا محلی و نه next/font/google؟
 * نسخه‌ی Google Fonts فونت، مجموعه‌ی استایلیستی «ss01» (تبدیل ارقام لاتین به
 * فارسی ۰-۹) را در خط تولید خود حذف می‌کند؛ بنابراین
 * `font-feature-settings: "ss01"` روی آن بی‌اثر است. فایل رسمی این ویژگی را
 * دارد و کلاس کمکی `.fa-digits` در globals.css را فعال می‌کند.
 */
const vazir = localFont({
  src: "./fonts/Vazirmatn-Variable.woff2",
  weight: "100 900",
  display: "swap",
  variable: "--font-vazir",
})

export const metadata: Metadata = {
  title: "روزساز",
  description: "سیستم هوشمند برنامه‌ریزی، مدیریت کارها و تقویم روزانه",
}

const themeScript = `
(function () {
  try {
    // تنظیمات user-scoped هستند (dp:settings:u<id> | dp:settings:anon) و
    // scope از کلید نشستِ لایه‌ی آفلاین خوانده می‌شود — همان قاعده‌ی
    // scopeToken() در app/lib/reminder.ts.
    var uid = localStorage.getItem("dp:offline:v3:user");
    var scope = uid && /^[0-9]+$/.test(uid) ? "u" + uid : "anon";
    var raw = localStorage.getItem("dp:settings:" + scope);
    var theme = "system";
    if (raw) { theme = JSON.parse(raw).theme || "system"; }
    var dark = theme === "dark" || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
  } catch (e) {
    document.documentElement.setAttribute("data-theme", "light");
  }
})();
`

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fa" dir="rtl" className={vazir.variable} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />

        {/* ===== PWA ===== */}
        <link rel="manifest" href="/manifest.webmanifest" />
        <link rel="preload" as="image" href="/animated-logo.gif" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="default" />
        <meta name="apple-mobile-web-app-title" content="روزساز" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        <meta name="theme-color" media="(prefers-color-scheme: light)" content="#6366f1" />
        <meta name="theme-color" media="(prefers-color-scheme: dark)" content="#0b1120" />
        <meta name="enamad" content="31470106" />
      </head>          <body className={vazir.className}>
        <Splash />
        <CalendarProvider>
          <SettingsProvider>
            <ReminderProvider>
              {children}
              <OfflineIndicator />
              <ToastContainer position="bottom-left" rtl closeOnClick pauseOnHover />
              <PwaRegister />
            </ReminderProvider>
          </SettingsProvider>
        </CalendarProvider>
      </body>
    </html>
  )
}
