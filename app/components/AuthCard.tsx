import Logo from "./Logo"

type Props = {
    title: string
    subtitle?: string
    children: React.ReactNode
}

// کارت مشترک صفحات ورود/ثبت‌نام — بخشی از الگوی طراحی واحد اپلیکیشن
export default function AuthCard({ title, subtitle, children }: Props) {
    return (
        <div className="dp-auth-card">
            <div className="dp-auth-brand">
                <Logo />
            </div>
            <h1 className="dp-auth-title">{title}</h1>
            {subtitle && <p className="dp-auth-sub">{subtitle}</p>}
            {children}
        </div>
    )
}