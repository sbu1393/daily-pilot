import type { Metadata } from "next"
import { Vazirmatn } from "next/font/google"
import "./globals.css"
import "react-toastify/dist/ReactToastify.css"
import { CalendarProvider } from "./contexts/CalenderContext"
import { SettingsProvider } from "./contexts/SettingsContext"
import PwaRegister from "./components/PwaRegister"
import OfflineIndicator from "./components/OfflineIndicator"
import { ToastContainer } from "react-toastify"

const vazir = Vazirmatn({
  subsets: ["arabic"],
  variable: "--font-vazir",
  display: "swap",
})

export const metadata: Metadata = {
  title: "Daily Pilot",
  description: "مدیریت هوشمند کارهای روزانه با هوش مصنوعی",
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
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="default" />
        <meta name="apple-mobile-web-app-title" content="Daily Pilot" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        <meta name="theme-color" media="(prefers-color-scheme: light)" content="#6366f1" />
        <meta name="theme-color" media="(prefers-color-scheme: dark)" content="#0b1120" />
      </head>          <body className={vazir.className}>
        <CalendarProvider>
          <SettingsProvider>
            {children}
            <OfflineIndicator />
            <ToastContainer position="bottom-left" rtl closeOnClick pauseOnHover />
            <PwaRegister />
          </SettingsProvider>
        </CalendarProvider>
      </body>
    </html>
  )
}