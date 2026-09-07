type SurfaceProps={
    children:React.ReactNode;
    title?:string;
    };
    
    
    export default function Surface({
    children,
    title
    }:SurfaceProps){
    
    
    return (
    
    <section className="surface">
    
    
    {
    title &&
    <h3 className="surface-title">
    {title}
    </h3>
    }
    
    
    <div>
    {children}
    </div>
    
    
    </section>
    
    )
    
    }