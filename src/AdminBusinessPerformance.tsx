import { useCallback,useEffect,useState } from 'react';
import { BarChart3, RefreshCw } from 'lucide-react';

type Row={id:string;name:string;regionName:string;status:string;orderCount:number;ordersInPeriod:number;revenueRial:string;commissionRial:string;awaitingResponse:number;avgPrepMinutes:number|null;unpaidDeliveredRial:string};
type Report={period:string;periodLabel:string;currency:string;items:Row[]};
const money=(value:string)=>new Intl.NumberFormat('fa-IR').format(BigInt(value||'0'))+' ریال';
const number=(value:number)=>new Intl.NumberFormat('fa-IR').format(value);
const statusLabel:Record<string,string>={ACTIVE:'فعال',PAUSED:'متوقف',PENDING:'در انتظار تأیید',REJECTED:'ردشده',SUSPENDED:'معلق'};

export default function AdminBusinessPerformance({token}:{token:string}){
 const[period,setPeriod]=useState('7d');const[report,setReport]=useState<Report|null>(null);const[busy,setBusy]=useState(false);const[error,setError]=useState('');
 const load=useCallback(async(value:string)=>{
  setBusy(true);setError('');
  try{
   const response=await fetch(`/api/v1/admin/reports/business-performance?period=${encodeURIComponent(value)}`,{headers:{Authorization:`Bearer ${token}`}});
   const data=await response.json().catch(()=>({}));
   if(!response.ok)throw new Error((data as {message?:string}).message||`خطا (${response.status})`);
   setReport(data as Report);
  }catch(e){setError((e as Error).message);setReport(null);}finally{setBusy(false);}
 },[token]);
 useEffect(()=>{void load(period);},[load,period]);
 const items=report?.items??[];
 const totals=items.reduce((acc,row)=>({revenue:acc.revenue+BigInt(row.revenueRial||'0'),commission:acc.commission+BigInt(row.commissionRial||'0'),orders:acc.orders+row.ordersInPeriod,unpaid:acc.unpaid+BigInt(row.unpaidDeliveredRial||'0')}),{revenue:0n,commission:0n,orders:0,unpaid:0n});
 return <section className="admin-card performance-card">
  <div className="queue-heading"><div><span className="setting-icon performance-icon"><BarChart3 size={18}/></span><div><h2>عملکرد کسب‌وکارها</h2><small>مرتب‌شده بر اساس فروش {report?.periodLabel??'بازهٔ انتخابی'} · تا ۵۰ کسب‌وکار</small></div></div>
   <div className="monitor-actions"><select aria-label="بازهٔ گزارش عملکرد" value={period} onChange={e=>setPeriod(e.target.value)}><option value="24h">۲۴ ساعت</option><option value="7d">۷ روز</option><option value="30d">۳۰ روز</option></select><button className="refresh-button" disabled={busy} onClick={()=>void load(period)}><RefreshCw size={14}/>{busy?'در حال محاسبه…':'تازه‌سازی'}</button></div></div>
  {error&&<div className="feedback error" role="alert">{error}</div>}
  {busy&&!items.length?<div className="queue-empty">در حال محاسبهٔ عملکرد…</div>:!items.length?<div className="queue-empty">در این بازه سفارشی ثبت نشده است.</div>:<>
   <div className="performance-table"><div className="performance-row performance-head"><span>کسب‌وکار</span><span>سفارش</span><span>فروش</span><span>کمیسیون</span><span>میانگین آماده‌سازی</span><span>بدهی وصول‌نشده</span></div>
    {items.map(row=><div className="performance-row" key={row.id}>
     <span className="performance-name"><b>{row.name}</b><small>{row.regionName} · {statusLabel[row.status]||row.status}{row.awaitingResponse>0?` · ${number(row.awaitingResponse)} در انتظار پاسخ`:''}</small></span>
     <span>{number(row.ordersInPeriod)}<small>{number(row.orderCount)} کل</small></span>
     <span>{money(row.revenueRial)}</span>
     <span>{money(row.commissionRial)}</span>
     <span>{row.avgPrepMinutes?`${number(row.avgPrepMinutes)} دقیقه`:'—'}</span>
     <span className={Number(row.unpaidDeliveredRial)>0?'performance-due':''}>{Number(row.unpaidDeliveredRial)>0?money(row.unpaidDeliveredRial):'—'}</span>
    </div>)}</div>
   <div className="performance-foot"><span>جمع این فهرست · {number(totals.orders)} سفارش</span><b>فروش {money(totals.revenue.toString())} · کمیسیون {money(totals.commission.toString())}{Number(totals.unpaid)>0?` · وصول‌نشده ${money(totals.unpaid.toString())}`:''}</b></div></>}
 </section>;
}
