import { useCallback,useEffect,useState } from 'react';
import { ChevronLeft, ChevronRight, RefreshCw, Search } from 'lucide-react';

type Order={id:string;status:string;paymentStatus:string;totalRial:string;createdAt:string;deliveryAddress:string;businessName:string;customerPhone:string;driverPhone:string|null};
type Page={items:Order[];totalMatches:number;limit:number;offset:number};
const PAGE_SIZE=25;
const labels:Record<string,string>={PENDING_BUSINESS:'در انتظار کسب‌وکار',CONFIRMED:'تأییدشده',PREPARING:'در حال آماده‌سازی',READY_FOR_PICKUP:'آمادهٔ تحویل به پیک',DRIVER_ASSIGNED:'پیک تخصیص‌یافته',OUT_FOR_DELIVERY:'در مسیر',DELIVERED:'تحویل‌شده',REJECTED:'ردشده',CANCELLED:'لغوشده',UNDER_REVIEW:'نیازمند بررسی'};
const money=(value:string)=>new Intl.NumberFormat('fa-IR').format(BigInt(value))+' ریال';
const date=(value:string)=>new Intl.DateTimeFormat('fa-IR-u-ca-persian',{dateStyle:'medium',timeStyle:'short'}).format(new Date(value));
const number=(value:number)=>new Intl.NumberFormat('fa-IR').format(value);

export default function AdminOrderMonitor({token}:{token:string}){
 const[status,setStatus]=useState('');const[searchInput,setSearchInput]=useState('');const[search,setSearch]=useState('');
 const[page,setPage]=useState<Page|null>(null);const[busy,setBusy]=useState(false);const[error,setError]=useState('');
 const load=useCallback(async(next:{status:string;search:string;offset:number})=>{
  setBusy(true);setError('');
  try{
   const params=new URLSearchParams({limit:String(PAGE_SIZE),offset:String(next.offset)});
   if(next.status)params.set('status',next.status);
   if(next.search)params.set('search',next.search);
   const response=await fetch(`/api/v1/admin/orders?${params.toString()}`,{headers:{Authorization:`Bearer ${token}`}});
   const data=await response.json().catch(()=>({}));
   if(!response.ok)throw new Error((data as {message?:string}).message||`خطا (${response.status})`);
   setPage(data as Page);
  }catch(e){setError((e as Error).message);}finally{setBusy(false);}
 },[token]);
 useEffect(()=>{void load({status,search,offset:0});},[load,status,search]);
 const total=page?.totalMatches??0;
 const items=page?.items??[];
 const offset=page?.offset??0;
 const goTo=(nextOffset:number)=>void load({status,search,offset:nextOffset});
 return <section className="admin-card admin-order-monitor">
  <header className="monitor-heading"><div><span className="setting-icon"><Search size={17}/></span><div><h2>سفارش‌های پلتفرم</h2><small>جستجو با شمارهٔ مشتری، نام کسب‌وکار یا ۸ رقم اول کد سفارش</small></div></div>
   <div className="monitor-actions"><select aria-label="فیلتر وضعیت سفارش" value={status} onChange={e=>setStatus(e.target.value)}><option value="">همهٔ وضعیت‌ها</option>{Object.entries(labels).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select>
    <form className="monitor-search" onSubmit={e=>{e.preventDefault();setSearch(searchInput.trim());}}><input aria-label="جستجوی سفارش" value={searchInput} onChange={e=>setSearchInput(e.target.value)} placeholder="شماره مشتری یا نام کسب‌وکار" autoComplete="off"/><button type="submit" disabled={busy||searchInput.trim().length<2}>جستجو</button></form>
    <button className="refresh-button" disabled={busy} onClick={()=>void load({status,search,offset})}><RefreshCw size={14}/>{busy?'در حال دریافت…':'تازه‌سازی'}</button></div></header>
  {error&&<div className="feedback error" role="alert">{error}</div>}
  {busy&&items.length===0?<div className="queue-empty">در حال بارگذاری سفارش‌ها…</div>:items.length===0?<div className="queue-empty">سفارشی برای این فیلتر یا جستجو پیدا نشد.</div>:<>
   <div className="admin-order-list">{items.map(order=><article className="admin-order-row" key={order.id}><div className="admin-order-main"><div><b>{order.businessName}</b><small>#{order.id.slice(0,8).toUpperCase()} · {date(order.createdAt)}</small></div><span className={`status-pill status-${order.status.toLowerCase()}`}>{labels[order.status]||order.status}</span></div><div className="admin-order-meta"><span>مشتری <b dir="ltr">{order.customerPhone}</b></span><span>مبلغ <b>{money(order.totalRial)}</b></span><span>پرداخت <b>{order.paymentStatus==='PAID'?'وصول‌شده':'در انتظار وصول'}</b></span><span>راننده <b dir="ltr">{order.driverPhone||'هنوز تخصیص نیافته'}</b></span><span className="admin-order-address">نشانی <b>{order.deliveryAddress}</b></span></div></article>)}</div>
   <div className="monitor-pager"><span>{number(offset+1)}–{number(offset+items.length)} از {number(total)} سفارش{search?` · نتیجهٔ «${search}»`:''}</span><div>
    <button className="pager-button" disabled={busy||offset<=0} onClick={()=>goTo(Math.max(0,offset-PAGE_SIZE))}><ChevronRight size={14}/>قبلی</button>
    <button className="pager-button" disabled={busy||offset+items.length>=total} onClick={()=>goTo(offset+PAGE_SIZE)}>بعدی<ChevronLeft size={14}/></button></div></div></>}
 </section>;
}
