"use client"

type LogoProps = {
    size?: number
}

export default function Logo({ size = 44 }: LogoProps) {
    // پدینگ کپسول با اندازه لوگو مقیاس می‌شود تا شکل pill در همهجا حفظ شود
    const padY = Math.round(size * 0.09)
    const padX = Math.round(size * 0.16)

    return (
        <span
            style={{
                display: "inline-flex",
                alignItems: "center",
                background: "var(--primary-soft, #eef2ff)",
                borderRadius: 999,
                padding: `${padY}px ${padX}px`,
                lineHeight: 0,
            }}
        >
            {/* لوگوی PNG بوم ۱٫۵:۱ با پسزمینهی خالی دارد (اثر واقعی در نوار میانی است)؛
                قاب با نسبت ۴٫۴:۱ + object-fit: cover دقیقاً همان نوار را نشان میدهد
                تا لوگو فضای کپسول را پر کند بدون حاشیهی خالی یا بریدن اثر. */}
            <span
                style={{
                    height: size,
                    aspectRatio: "4.4 / 1",
                    maxWidth: "40vw",
                    overflow: "hidden",
                    display: "block",
                }}
            >
                <img
                    src="/logo.png"
                    alt="روزچین"
                    style={{
                        height: "100%",
                        width: "100%",
                        objectFit: "cover",
                        objectPosition: "50% 47%",
                        display: "block",
                    }}
                />
            </span>
        </span>
    )
}
