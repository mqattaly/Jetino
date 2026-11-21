import { useCallback,useEffect,useState } from 'react';
import { ChevronLeft,ChevronRight,History,RefreshCw } from 'lucide-react';
import { SkeletonList } from './ui/motion';

type Entry={id:string;action:string;entityType:string;entityId:string|null;createdAt:string;actorName:string|null;actorPhone:string|null;metadata:Record<string,unknown>;redacted:number};
type Page={items:Entry[];totalMatches:number;limit:number;offset:number};
type Vocabulary={items:Array<{action:string;occurrences:number;lastUsed:string}>};

const PAGE=25;
const labels:Record<string,string>={
 ADMIN_AUDIT_READ:'مشاهدهٔ گزارش حسابرسی',ADDRESS_CREATED:'ثبت نشانی',ADDRESS_UPDATED:'ویرایش نشانی',ADDRESS_DELETED:'حذف نشانی',
 AUTH_OTP_LOGIN:'ورود با کد یک‌بارمصرف',BUSINESS_APPLICATION_CREATED:'درخواست راه‌اندازی کسب‌وکار',BUSINESS_LOCATION_UPDATED:'تغییر محل کسب‌وکار',
 BUSINESS_ORDERABILITY_CHANGED:'تغییر وضعیت پذیرش سفارش',BUSINESS_STATUS_CHANGED:'تغییر وضعیت کسب‌وکار',BUSINESS_UPDATED:'ویرایش اطلاعات کسب‌وکار',
 CANCEL_POLICY_UPDATED:'تغییر قوانین لغو',CASH_PAYMENT_COLLECTED:'وصول وجه نقد',CASH_PAYMENT_CONFIRMED:'تأیید دریافت وجه نقد',CASH_SETTLEMENT_RECORDED:'ثبت تسویهٔ راننده',
 FEEDBACK_REMOVED:'حذف بازخورد سفارش',
 DEFAULT_COMMISSION_UPDATED:'تغییر کمیسیون پیش‌فرض',DRIVER_ASSIGNED:'تخصیص راننده',DRIVER_ORDER_STATUS_CHANGED:'تغییر وضعیت سفارش توسط راننده',
 DRIVER_REGISTERED:'افزودن راننده',DRIVER_STATUS_CHANGED:'تغییر وضعیت راننده',MENU_CATEGORY_CREATED:'افزودن دستهٔ منو',
 MENU_PRODUCT_CREATED:'افزودن محصول',MENU_PRODUCT_UPDATED:'ویرایش محصول',ORDER_CANCELLED:'لغو سفارش',ORDER_CREATED:'ثبت سفارش',
 ORDER_CANCEL_REQUESTED:'ثبت درخواست لغو',ORDER_CANCELLATION_DECIDED:'پاسخ به درخواست لغو',ORDER_REFUNDED:'ثبت بازپرداخت سفارش',ORDER_STATUS_CHANGED:'تغییر وضعیت سفارش',
 REGION_DELIVERY_FEE_UPDATED:'تغییر کرایهٔ منطقه',SUPPORT_TICKET_STATUS:'تغییر وضعیت تیکت پشتیبانی',SUPER_ADMIN_BOOTSTRAPPED:'ساخت حساب مدیر کل',
};
const entityLabels:Record<string,string>={AUDIT_QUERY:'جست‌وجوی گزارش',ORDER:'سفارش',USER:'کاربر',BUSINESS:'کسب‌وکار',ADDRESS:'نشانی',PRODUCT:'محصول',REGION:'منطقه',CASH_SETTLEMENT:'تسویه',CASH_COLLECTION:'وصول وجه',PLATFORM_SETTING:'تنظیمات پلتفرم',DRIVER:'راننده',ORDER_FEEDBACK:'بازخورد سفارش',SUPPORT_TICKET:'تیکت پشتیبانی',CANCELLATION_POLICY:'قوانین لغو'};
const dateTime=(value:string)=>new Intl.DateTimeFormat('fa-IR-u-ca-persian',{dateStyle:'short',timeStyle:'short'}).format(new Date(value));
const number=(value:number)=>new Intl.NumberFormat('fa-IR').format(value);
const shortId=(value:string|null)=>value?value.length>8?`${value.slice(0,8).toUpperCase()}…`:value.toUpperCase():'—';
const queryOf=(filters:{action:string;entity:string;since:string;until:string},offset:number)=>{
 const query=new URLSearchParams({limit:String(PAGE),offset:String(offset)});
 if(filters.action)query.set('action',filters.action);
 if(filters.entity.trim())query.set('entityId',filters.entity.trim());
 // a date input names a local calendar day: expand it to the widest window that day allows
 if(filters.since)query.set('since',new Date(`${filters.since}T00:00:00`).toISOString());
 if(filters.until)query.set('until',new Date(`${filters.until}T23:59:59`).toISOString());
 return query;
};

export default function AdminAuditLog({token}:{token:string}){
 const[action,setAction]=useState('');const[entity,setEntity]=useState('');const[since,setSince]=useState('');const[until,setUntil]=useState('');
 const[vocabulary,setVocabulary]=useState<string[]>([]);
 const[page,setPage]=useState<Page|null>(null);const[busy,setBusy]=useState(false);const[error,setError]=useState('');const[open,setOpen]=useState<string|null>(null);
 // filters are passed in, never read from the closure, so typing in the id box only
 // costs a request when the form is submitted rather than on every keystroke
 const load=useCallback(async(filters:{action:string;entity:string;since:string;until:string},offset=0)=>{
  setBusy(true);setError('');
  try{
   const response=await fetch(`/api/v1/admin/audit-logs?${queryOf(filters,offset).toString()}`,{headers:{Authorization:`Bearer ${token}`}});
   const data=await response.json().catch(()=>({}));
   if(!response.ok)throw new Error((data as {message?:string}).message||`خطا (${response.status})`);
   setPage(data as Page);
  }catch(e){setError((e as Error).message);setPage(null);}finally{setBusy(false);}
 },[token]);
 useEffect(()=>{
  // the filter list is built from what the log actually contains, so it can never offer a no-op choice
  void (async()=>{
   try{
    const response=await fetch('/api/v1/admin/audit-logs/actions',{headers:{Authorization:`Bearer ${token}`}});
    if(response.ok)setVocabulary(((await response.json() as Vocabulary).items??[]).map(row=>row.action));
   }catch{/* reading still works with a free-text entity filter if the vocabulary call fails */}
  })();
 },[token]);
 useEffect(()=>{void load({action,entity,since,until});},[action,since,until,load]);
 const items=page?.items??[];
 const lastOffset=Math.max(0,(page?.totalMatches??0)-1);
 return <section className="admin-card">
  <header className="monitor-heading"><div><span className="setting-icon audit-icon"><History size={17}/></span><div><h2>گزارش عملیات حساس</h2><small>تغییرهای مالی، وضعیت و دسترسی‌ها · شمارهٔ تماس بازیابی‌کننده فقط با ۴ رقم آخر نمایش داده می‌شود و خودِ این مشاهده هم ثبت می‌شود</small></div></div>
   <div className="monitor-actions">
    <select aria-label="نوع عملیات" value={action} onChange={e=>setAction(e.target.value)}><option value="">همهٔ عملیات‌ها</option>{[...new Set([...vocabulary,action].filter(Boolean))].sort().map(name=><option key={name} value={name}>{labels[name]??name}</option>)}</select>
    <form className="monitor-search" onSubmit={e=>{e.preventDefault();void load({action,entity,since,until});}}>
     <input aria-label="شناسهٔ سفارش یا کسب‌وکار" value={entity} onChange={e=>setEntity(e.target.value)} placeholder="کد سفارش یا uuid موجودیت" autoComplete="off" dir="ltr"/>
     <button type="submit" disabled={busy}>اعمال</button>
    </form>
    <label className="audit-date"><span>از</span><input type="date" aria-label="از تاریخ" value={since} onChange={e=>setSince(e.target.value)}/></label>
    <label className="audit-date"><span>تا</span><input type="date" aria-label="تا تاریخ" value={until} onChange={e=>setUntil(e.target.value)}/></label>
    <button className="refresh-button" disabled={busy} onClick={()=>void load({action,entity,since,until})}><RefreshCw size={14}/>{busy?'در حال خواندن…':'تازه‌سازی'}</button>
   </div></header>
  {error&&<div className="feedback error" role="alert">{error}</div>}
  {busy&&items.length===0?<SkeletonList rows={4} label="در حال خواندن گزارش…"/>:items.length===0?<div className="queue-empty">رویدادی با این فیلترها پیدا نشد.</div>:<>
   <div className="audit-list">{items.map(entry=><article className="audit-entry" key={entry.id}>
    <div className="audit-entry-top"><b>{labels[entry.action]??entry.action}</b><span className="status-pill">{entityLabels[entry.entityType]??entry.entityType} · {shortId(entry.entityId)}</span><small>{dateTime(entry.createdAt)}</small></div>
    <div className="audit-entry-meta"><span>توسط {entry.actorName??'سیستم'}{entry.actorPhone?` · ${entry.actorPhone}`:''}</span>{(Object.keys(entry.metadata).length>0||entry.redacted>0)&&<button type="button" className="audit-toggle" aria-expanded={open===entry.id} onClick={()=>setOpen(open===entry.id?null:entry.id)}>{open===entry.id?'بستن جزئیات':'جزئیات'}</button>}</div>
    {open===entry.id&&<div className="audit-details"><pre>{JSON.stringify(entry.metadata,null,2)}</pre>{entry.redacted>0&&<small>{number(entry.redacted)} فیلد حساس این رکورد نمایش داده نمی‌شود.</small>}</div>}
   </article>)}</div>
   <div className="monitor-pager"><span>{number((page?.offset??0)+1)}–{number(Math.min(lastOffset+1,(page?.offset??0)+items.length))} از {number(page?.totalMatches??0)} رویداد{action?` · ${labels[action]??action}`:''}</span><div>
    <button className="pager-button" disabled={busy||(page?.offset??0)<=0} onClick={()=>void load({action,entity,since,until},Math.max(0,(page?.offset??0)-PAGE))}><ChevronRight size={14}/>قبلی</button>
    <button className="pager-button" disabled={busy||(page?.offset??0)>=lastOffset} onClick={()=>void load({action,entity,since,until},(page?.offset??0)+PAGE)}>بعدی<ChevronLeft size={14}/></button></div></div></>}
 </section>;
}
