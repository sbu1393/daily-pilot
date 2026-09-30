"use client"

import AnimatedModal from "../motion/AnimatedModal"
import QuotaExceededContent from "./QuotaExceededContent"

// QuotaExceededModal — پوستهٔ مودال برای جاهایی که هیچ مودالی باز نیست
// (مثل شکست «ایجاد برنامه»). خودِ محتوا قابل reuse است؛ برای ReanalyzeModal
// که از قبل مودال باز دارد، مستقیماً QuotaExceededContent رندر می‌شود تا
// مودال تو‌در‌تو ساخته نشود.

type Props = {
    open: boolean
    onClose: () => void
}

export default function QuotaExceededModal({ open, onClose }: Props) {
    return (
        <AnimatedModal open={open} onClose={onClose}>
            <QuotaExceededContent onClose={onClose} />
        </AnimatedModal>
    )
}
