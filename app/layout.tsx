import type { Metadata } from "next"
import localFont from "next/font/local"
import "./globals.css"
import "react-toastify/dist/ReactToastify.css"
import { CalendarProvider } from "./contexts/CalenderContext"
import { SettingsProvider } from "./contexts/SettingsContext"
import PwaRegister from "./components/PwaRegister"
import OfflineIndicator from "./components/OfflineIndicator"
import Splash from "./components/Splash"
import { ToastContainer } from "react-toastify"
import RecaptchaWrapper from "./components/providers/RecaptchaWrapper"

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
    var raw = localStorage.getItem("dp:settings");
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
      </head>          <body className={vazir.className}>
        <RecaptchaWrapper>
          <Splash />
          <CalendarProvider>
            <SettingsProvider>
              {children}
              <OfflineIndicator />
              <ToastContainer position="bottom-left" rtl closeOnClick pauseOnHover />
              <PwaRegister />
            </SettingsProvider>
          </CalendarProvider>
        </RecaptchaWrapper>
      </body>
    </html>
  )
}
