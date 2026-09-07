import {NextRequest,NextResponse} from "next/server"
import {getPrisma} from "@/app/lib/getPrisma"
import bcrypt from "bcrypt"
import { registerSchema } from "@/app/schema/formSchema"
import { isRateLimited, clientIp } from "@/app/lib/rateLimit"
    
    
    
    export async function POST(
    req:NextRequest
    ){
    
    
    try{

    // محدودیت نرخ: حداکثر چند ثبت‌نام از یک IP در یک بازه
    if (isRateLimited(`register:ip:${clientIp(req)}`, 5, 60 * 60 * 1000)) {
        return NextResponse.json(
            { message: "تعداد ثبت‌نام‌ها زیاد شده؛ کمی بعد دوباره تلاش کن" },
            { status: 429 }
        )
    }

    const body =
    await req.json()
    
    const validation =
    registerSchema.safeParse(body)
    

    if(!validation.success){

    return NextResponse.json(
    {message:"اطلاعات نامعتبر است", errors:validation.error.flatten()}, {status:400})
    }
    
    
    
    const {
    username,
    email,
    password
    }=validation.data
    
    
    
    const prisma =
    getPrisma()
    
    
    
    const exist =
    await prisma.user.findUnique({
    
    where:{
    email
    }
    
    })
    
    if(exist){
    
    return NextResponse.json(
    {
    message:"این ایمیل قبلا ثبت شده"
    },
    {
    status:409
    }
    )
    
    }
    
    
    
    const hashedPassword =
    await bcrypt.hash(
    password,
    12
    )
    
    
    
    const user =
    await prisma.user.create({
    
    data:{
    
    username,
    
    email,
    
    password:hashedPassword
    
    }
    
    })
    
    
    
    return NextResponse.json(
    {
    message:"ثبت نام موفق بود",
    user:{
    id:user.id,
    email:user.email
    }
    },
    {
    status:201
    }
    )
    
    
    
    }
    catch(error){
    
    
    return NextResponse.json(
    
    {
    message:"خطای سرور"
    },
    
    {
    status:500
    }
    
    )
    
    
    }
    
    
    }