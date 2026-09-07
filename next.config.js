/** @type {import('next').NextConfig} */
const nextConfig = {
    async headers() {
        return [
            {
                // سرویس‌کاربر همیشه باید تازه دریافت شود تا آپدیت‌ها اعمال شوند
                source: "/sw.js",
                headers: [
                    { key: "Cache-Control", value: "public, max-age=0, must-revalidate" },
                    { key: "Service-Worker-Allowed", value: "/" },
                ],
            },
            {
                source: "/manifest.webmanifest",
                headers: [{ key: "Cache-Control", value: "public, max-age=3600" }],
            },
        ]
    },
}

module.exports = nextConfig
