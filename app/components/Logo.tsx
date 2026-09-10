"use client"

type LogoProps = {
    size?: number
}

export default function Logo({ size = 32 }: LogoProps) {
    return (
        <img
            src="/logo.png"
            alt="روزچین"
            style={{ height: size, width: "auto" }}
        />
    )
}