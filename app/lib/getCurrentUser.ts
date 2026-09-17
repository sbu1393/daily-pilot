import { cookies } from "next/headers"
import jwt from "jsonwebtoken"
import { getPrisma } from "./getPrisma"




export async function getCurrentUser(){


    const cookieStore = await cookies()


    const token = cookieStore.get("token")


    if(!token){

        return null

    }



    const secret = process.env.JWT_SECRET


    if(!secret){

        throw new Error(
            "JWT_SECRET is not defined"
        )

    }    let decoded: { id: number; email: string }



    // M1 — انتظاری: توکن نامعتبر/منقضی/دستکاری‌شده → کاربر ناشناس، بدون لاگ نویز.

    try{


        decoded = jwt.verify(
            token.value,
            secret
        ) as {

            id:number
            email:string

        }



    }
    catch{


        return null

    }



    // M1 — غیرانتظاری: خطای زیرساخت/دیتابیس. بازگرداندن null یعنی «نشستی وجود ندارد»

    // و به ۴۰۱ گمراه‌کننده تبدیل می‌شود؛ پس با context لاگ می‌شود و بالا می‌رود تا مسیر

    // استاندارد ۵۰۰ (ADR-02/ADR-04) آن را مدیریت کند. جزئیات خام هرگز به کلاینت نمی‌رود.

    try{


        return await getPrisma().user.findUnique({

            where:{
                id:decoded.id
            },

            select:{

                id:true,

                username:true,

                email:true,

                firstName:true,

                lastName:true,

                image:true,

                birthDate:true,

                phone:true,

                timezone:true,

                // فاز ۱ — plan برای planPolicy (resolve سهمیه ماهانه AI؛ سند §5)
                plan:true,
                // فاز ۴ — role از DB در هر request خوانده می‌شود؛ هرگز داخل JWT نمی‌رود
                // (revocation فوری در request بعدی؛ سند Phase 4 «Role Model»)
                role:true,

            }

        })



    }
    catch(error){


        console.error("getCurrentUser: user lookup failed", {

            userId: decoded.id,

            error,

        })



        throw error

    }

}