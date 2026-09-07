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

    }



    try{


        const decoded = jwt.verify(
            token.value,
            secret
        ) as {

            id:number
            email:string

        }



        const user = await getPrisma().user.findUnique({

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

                phone:true

            }

        })



        return user



    }
    catch(error){


        return null


    }


}