import { useCallback, useEffect, useState } from 'react';
import { Banknote, RefreshCw } from 'lucide-react';

type Outstanding={driverId:string;driverPhone:string;regionName:string;openCount:number;openCashRial:string;lastCollectedAt:string};
const money=(value:string)=>new Intl.NumberFormat('fa-IR',{maximumFractionDigits:0}).format(Number(value))+' ریال';
const number=(value:number|string)=>new Intl.NumberFormat('fa-IR').format(Number(value));
const day=(value:string)=>new Intl.DateTimeFormat('fa-IR-u-ca-persian',{dateStyle:'medium'}).format(new Date(value));

async function request<T>(path:string,token:string,init?:RequestInit):Promise<T>{
  const response=await fetch(path,{...init,headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`,...(init?.headers||{})}});
  const data=await response.json().catch(()=>({})) as T&{message?:string};
  if(!response.ok) throw new Error(typeof data.message==='string'?data.message:`خطا (${response.status})`);
  return data;
}

export default function AdminCashSettlement({token,onSettled}:{token:string;onSettled?:()=>void}){
 const [rows,setRows]=useState<Outstanding[]>([]);
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState('');
 const [notice,setNotice]=useState('');
 const [loading,setLoading]=useState(false);

 const load=useCallback(async()=>{
  setLoading(true);setError('');
  try{ setRows(await request<Outstanding[]>('/api/v1/admin/reports/cash-outstanding',token)); }
  catch(e){ setError((e as Error).message); }
  finally{ setLoading(false); }
 },[token]);
 useEffect(()=>{void load();},[load]);

 const settle=async(row:Outstanding)=>{
  if(!window.confirm(`تسویه ${money(row.openCashRial)} از حساب راننده ${row.driverPhone} ثبت شود؟`)) return;
  setBusy(true);setError('');setNotice('');
  try{
   const result=await request<{amountRial:string;orderCount:number}>('/api/v1/admin/reports/settlements',token,{method:'POST',body:JSON.stringify({driverId:row.driverId,expectedAmountRial:row.openCashRial})});
   setNotice(`تسویه ${money(result.amountRial)} برای ${number(result.orderCount)} سفارش ثبت شد.`);
   await load(); onSettled?.();
  }catch(e){ setError((e as Error).message); await load(); }
  finally{ setBusy(false); }
 };

 return <section className="admin-card cash-card">
  <div className="queue-heading"><div><span className="setting-icon cash-icon"><Banknote size={18}/></span><div><h2>تسویه وجه نقد رانندگان</h2><small>مبالغ وصول‌شده از مشتری که هنوز به راننده پرداخت نشده</small></div></div><button className="refresh-button" disabled={loading||busy} onClick={()=>void load()}><RefreshCw size={14}/>{loading?'در حال دریافت…':'تازه‌سازی'}</button></div>
  {error&&<div className="feedback error" role="alert">{error}</div>}
  {notice&&<div className="feedback success" role="status">{notice}</div>}
  {rows.length===0&&!loading?<div className="queue-empty">وجه باز برای تسویه وجود ندارد.</div>:<div className="cash-list">{rows.map(row=><div className="cash-row" key={row.driverId}><div className="cash-details"><b dir="ltr">{row.driverPhone}</b><span>{row.regionName} · {number(row.openCount)} سفارش · آخرین وصول {day(row.lastCollectedAt)}</span></div><div className="cash-amount"><strong>{money(row.openCashRial)}</strong><button className="approve-button" disabled={busy} onClick={()=>void settle(row)}>ثبت تسویه</button></div></div>)}</div>}
  <div className="snapshot-note"><RefreshCw size={16}/><span>تسویه فقط مبلغ ثبت‌شده در سامانه را صفر می‌کند؛ پرداخت واقعی در خارج از پنل انجام می‌شود و برای ثبت، مبلغ باید دقیقاً برابر ماندهٔ فعلی باشد.</span></div>
 </section>;
}
