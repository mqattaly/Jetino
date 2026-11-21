import { useCallback, useEffect, useState } from 'react';
import { Check, ChevronLeft, ChevronRight, Clock3, RefreshCw, ShieldCheck, Wallet, X } from 'lucide-react';
import { SkeletonList } from './ui/motion';

/**
 * §7.11 screens. A cancellation is shown as a *request* with an outcome, never as a button that
 * silently rewrites an order: the rules the platform grants, who asked, when, why and what the
 * staff answered are all on screen, and the refund ledger is read from the server totals only.
 */
type Policy = { autoCancelStatuses: string[]; windowMinutes: number };
type CancelRequest = { id:string; orderId:string; orderStatus:string; totalRial:string; paymentStatus:string; reason:string; outcome:string; note:string|null; createdAt:string; decidedAt:string|null; decidedBy:string|null; requesterName?:string|null; requesterTail?:string|null; refundCount?:number };
type OrderView = { order:{id:string;status:string;paymentStatus:string;totalRial:string}; policy:Policy; requests:CancelRequest[]; selfServe:boolean; cancellable:boolean; awaitingAnswer:boolean };
type Queue = { items:CancelRequest[]; counts:Record<string,number>; totalMatches:number; limit:number; offset:number };
type Ledger = { orderId:string; collectedRial:string; refundedRial:string; refundableRial:string; items:Array<{ id:string; amountRial:string; kind:string; destination:string; fundedBy:string; reason:string; createdAt:string; actorName:string }> };

const OUTCOMES = ['PENDING', 'ACCEPTED', 'REJECTED', 'VOIDED'] as const;
/** Mirrors POLICY_OPTIONS in the API; the route test fails if the two lists drift apart. */
const STATUS_OPTIONS = [{ value:'PENDING_BUSINESS', label:'پیش از پاسخ کسب‌وکار' }, { value:'CONFIRMED', label:'پس از تأیید، پیش از آماده‌سازی' }, { value:'PREPARING', label:'در حال آماده‌سازی' }, { value:'READY_FOR_PICKUP', label:'آمادهٔ تحویل به پیک' }] as const;
const REFUND_PARTIES = [{ value:'PLATFORM', label:'پلتفرم' }, { value:'BUSINESS', label:'کسب‌وکار' }, { value:'DRIVER', label:'پیک' }] as const;

const outcomeLabel=(outcome:string)=>({ PENDING:'در انتظار پاسخ', ACCEPTED:'تأیید شد', REJECTED:'رد شد', VOIDED:'بدون اقدام' } as Record<string,string>)[outcome]||outcome;
const statusLabel=(status:string)=>({ PENDING_BUSINESS:'در انتظار کسب‌وکار', CONFIRMED:'تأییدشده', PREPARING:'در حال آماده‌سازی', READY_FOR_PICKUP:'آمادهٔ تحویل', DRIVER_ASSIGNED:'پیک تخصیص یافت', OUT_FOR_DELIVERY:'در مسیر تحویل', DELIVERED:'تحویل شد', REJECTED:'پذیرفته نشد', CANCELLED:'لغو شد', UNDER_REVIEW:'در حال بررسی' } as Record<string,string>)[status]||status;
const fa=(value:number|string)=>new Intl.NumberFormat('fa-IR').format(Number(value));
const money=(rial:string|number)=>`${fa(Number(rial||0))} ریال`;
const dateTime=(value:string|null)=>value?new Intl.DateTimeFormat('fa-IR-u-ca-persian',{dateStyle:'short',timeStyle:'short'}).format(new Date(value)):'—';
const shortId=(value:string|null)=>value?value.slice(0,8).toUpperCase():'—';

async function requestJson<T>(path:string, token:string, init?:RequestInit):Promise<T>{
  const response=await fetch(path,{...init,headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`,...(init?.headers||{})}});
  const data=((await response.json().catch(()=>({})))??{}) as T&{message?:string};
  if(!response.ok){ const error=new Error(typeof data.message==='string'?data.message:`خطا (${response.status})`) as Error&{status?:number}; error.status=response.status; throw error; }
  return data;
}

/** The customer half: the rules that apply to this order, the answer if one was given, and the request form. */
export function OrderCancellationPanel({token, orderId, status, onChanged, onNotice}:{token:string; orderId:string; status:string; onChanged:()=>void; onNotice?:(message:string)=>void}){
  const [view,setView]=useState<OrderView|null>(null);
  const [reason,setReason]=useState('');
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');

  const load=useCallback(async()=>{
    try{ setView(await requestJson<OrderView>(`/api/v1/cancellations/orders/${orderId}`,token)); }
    catch(e){ setError((e as Error).message); }
  },[orderId,token]);
  useEffect(()=>{ void load(); },[load]);

  const submit=async()=>{
    setBusy(true); setError(''); setNotice('');
    try{
      const result=await requestJson<{status:string;message?:string}>(`/api/v1/orders/${orderId}/cancel`,token,{method:'POST',body:JSON.stringify({reason})});
      const text=result.status==='CANCELLED'?'سفارش لغو شد و برای کسب‌وکار ثبت گردانده شد.':(result.message||'درخواست لغو برای بررسی ثبت شد.');
      setNotice(text); onNotice?.(text);
      if(result.status==='CANCELLED') onChanged();
      setReason(''); await load();
    }catch(e){ setError((e as Error).message); }
    finally{ setBusy(false); }
  };

  const open=view?.awaitingAnswer ?? view?.requests.some(item=>item.outcome==='PENDING');
  const settled=['DELIVERED','REJECTED','CANCELLED','UNDER_REVIEW'].includes(status);
  return <section className="cancel-panel">
    <div className="cancel-head"><b>لغو و بازپرداخت</b><small>{view?.selfServe?'تا زمانی که کسب‌وکار پاسخ نداده، خودتان می‌توانید لغو کنید.':view?.cancellable?'لغو این سفارش با تأیید کادر عملیات انجام می‌شود.':'این سفارش به نتیجه رسیده و لغوپذیر نیست.'}</small></div>
    {view&&<p className="cancel-rule"><ShieldCheck size={13}/><span>{view.policy.windowMinutes>0?`فقط تا ${fa(view.policy.windowMinutes)} دقیقه پس از ثبت سفارش· `:''}وضعیت‌های مجاز: {view.policy.autoCancelStatuses.map(value=>statusLabel(value)).join('، ')}</span></p>}
    {view&&view.requests.length>0&&<ul className="cancel-history">{view.requests.map(item=><li key={item.id}><Clock3 size={12}/><span>{item.reason}</span><em className={`cancel-outcome ${item.outcome.toLowerCase()}`}>{outcomeLabel(item.outcome)}</em>{item.note&&<small>{item.note}{item.decidedBy?` · ${item.decidedBy}`:''} · {dateTime(item.decidedAt||item.createdAt)}</small>}</li>)}</ul>}
    {error&&<div className="feedback error" role="alert">{error}</div>}
    {notice&&<div className="feedback success">{notice}</div>}
    {!settled&&!open&&<div className="cancel-form">
      <textarea value={reason} onChange={e=>setReason(e.target.value)} maxLength={300} rows={2} placeholder={view?.selfServe?'دلیل لغو (اختیاری تا پیش از پاسخ کسب‌وکار)':'دلیل لغو را بنویسید تا کادر عملیات بتواند پاسخ دهد'} aria-label="دلیل لغو سفارش"/>
      <button className="reject-button" disabled={busy||!view} onClick={()=>void submit()}>{busy?'در حال ثبت…':view?.selfServe?'لغو سفارش':'ثبت درخواست لغو'}</button>
    </div>}
    {open&&<p className="cancel-wait">درخواست شما در صف بررسی کادر عملیات است؛ نتیجه با اعلان به شما می‌رسد.</p>}
  </section>;
}

/** Operations board: the queue to answer, the rules to configure, and the ledger per order. */
export function CancellationBoard({token}:{token:string}){
  const [tab,setTab]=useState<(typeof OUTCOMES)[number]>('PENDING');
  const [search,setSearch]=useState('');
  const [applied,setApplied]=useState('');
  const [page,setPage]=useState(0);
  const [queue,setQueue]=useState<Queue|null>(null);
  const [policy,setPolicy]=useState<Policy|null>(null);
  const [notice,setNotice]=useState('');
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  const [notes,setNotes]=useState<Record<string,string>>({});
  const [ledger,setLedger]=useState<{orderId:string;data:Ledger|null;amount:string;reason:string;fundedBy:string;busy:boolean}|null>(null);

  const load=useCallback(async(nextTab:string,nextSearch:string,nextOffset:number)=>{
    const query=new URLSearchParams({outcome:nextTab,limit:'10',offset:String(nextOffset)});
    if(nextSearch) query.set('search',nextSearch);
    const [rows,rules]=await Promise.all([
      requestJson<Queue>(`/api/v1/cancellations/queue?${query.toString()}`,token),
      requestJson<Policy>('/api/v1/cancellations/policy',token),
    ]);
    setQueue(rows); setPolicy(rules);
  },[token]);
  useEffect(()=>{ setError(''); void load(tab,applied,page).catch(e=>setError((e as Error).message)); },[tab,applied,page,load]);

  const answer=async(item:CancelRequest,decision:'ACCEPT'|'REJECT')=>{
    setBusy(true); setError(''); setNotice('');
    try{
      const result=await requestJson<{outcome:string}>(`/api/v1/cancellations/requests/${item.id}`,token,{method:'PATCH',body:JSON.stringify({decision,note:notes[item.id]||''})});
      setNotice(result.outcome==='ACCEPTED'?'سفارش لغو شد و به کسب‌وکار اطلاع داده شد.':result.outcome==='VOIDED'?'این سفارش لغوپذیر نبود؛ درخواست بدون اقدام بسته شد.':'درخواست رد شد و دلیل برای مشتری ثبت شد.');
      setNotes(current=>({...current,[item.id]:''}));
      await load(tab,applied,page);
    }catch(e){ setError((e as Error).message); }
    finally{ setBusy(false); }
  };

  const savePolicy=async(next:Policy)=>{
    setBusy(true); setError('');
    try{
      setPolicy(await requestJson<Policy>('/api/v1/cancellations/policy',token,{method:'PATCH',body:JSON.stringify(next)}));
      setNotice('قوانین لغو به‌روزرسانی شد.');
      await load(tab,applied,page);
    }catch(e){ setError((e as Error).message); }
    finally{ setBusy(false); }
  };

  const openLedger=async(orderId:string)=>{
    const pendingRaw=sessionStorage.getItem(`jetino_refund_pending_${orderId}`);
    const pending=pendingRaw?JSON.parse(pendingRaw) as {amountRial:number;reason:string;fundedBy:string;requestKey:string}:null;
    const form={amount:pending?String(pending.amountRial):'',reason:pending?.reason||'',fundedBy:pending?.fundedBy||'PLATFORM'};
    setLedger({orderId,data:null,...form,busy:true});
    try{ setLedger({orderId,data:await requestJson<Ledger>(`/api/v1/cancellations/orders/${orderId}/refunds`,token),...form,busy:false}); }
    catch(e){ setError((e as Error).message); setLedger(null); }
  };

  const addRefund=async()=>{
    if(!ledger) return;
    setLedger({...ledger,busy:true}); setError('');
    try{
      const storageKey=`jetino_refund_pending_${ledger.orderId}`;
      const previous=sessionStorage.getItem(storageKey);
      const pending=previous?JSON.parse(previous) as {amountRial:number;reason:string;fundedBy:string;requestKey:string}:null;
      const amountRial=Number(ledger.amount||0);
      if(pending&&(pending.amountRial!==amountRial||pending.reason!==ledger.reason||pending.fundedBy!==ledger.fundedBy)) throw new Error('نتیجهٔ درخواست قبلی نامشخص است؛ ابتدا همان مبلغ و دلیل و طرف پرداخت‌کننده را دوباره ثبت و بررسی کنید.');
      const payload=pending||{amountRial,reason:ledger.reason,fundedBy:ledger.fundedBy,requestKey:crypto.randomUUID()};
      sessionStorage.setItem(storageKey,JSON.stringify(payload));
      await requestJson(`/api/v1/cancellations/orders/${ledger.orderId}/refunds`,token,{method:'POST',body:JSON.stringify(payload)});
      sessionStorage.removeItem(storageKey);
      setNotice('ردیف کیف پول ثبت یا تأیید شد.');
      await openLedger(ledger.orderId);
      await load(tab,applied,page);
    }catch(e){ const status=(e as Error&{status?:number}).status; if(status===400||status===409) sessionStorage.removeItem(`jetino_refund_pending_${ledger.orderId}`); setError((e as Error).message); setLedger({...ledger,busy:false}); }
  };

  const total=queue?.totalMatches??0;
  return <section className="admin-card cancellation-board">
    <div className="queue-heading"><div><span className="setting-icon cancel-icon">⇄</span><div><h2>لغو و بازپرداخت</h2><small>صف درخواست‌ها، قوانین پلتفرم و دفتر بازپرداخت</small></div></div><button className="refresh-button" onClick={()=>void load(tab,applied,page).catch(e=>setError((e as Error).message))}><RefreshCw size={14}/>نوسازی</button></div>
    {error&&<div className="feedback error" role="alert">{error}</div>}
    {notice&&<div className="feedback success">{notice}</div>}
    <div className="queue-tabs">{OUTCOMES.map(outcome=><button key={outcome} className={tab===outcome?'active':''} onClick={()=>{setTab(outcome);setPage(0);}}>{outcomeLabel(outcome)}{queue?.counts[outcome]?` (${fa(queue.counts[outcome])})`:''}</button>)}</div>
    <form className="cancel-search" onSubmit={e=>{e.preventDefault();setApplied(search.trim());setPage(0);}}>
      <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="نام مشتری، شمارهٔ تماس یا شناسهٔ سفارش" aria-label="جست‌وجو در درخواست‌های لغو"/>
      <button className="primary-button" type="submit">جست‌وجو</button>{applied&&<button type="button" className="refresh-button" onClick={()=>{setSearch('');setApplied('');setPage(0);}}><X size={13}/>پاک‌کردن</button>}
    </form>
    {!queue?<SkeletonList rows={3} label="در حال خواندن درخواست‌های لغو…"/>:queue.items.length===0?<div className="queue-empty">{tab==='PENDING'?'درخواست بازی برای بررسی نمانده است.':'موردی در این وضعیت نیست.'}</div>:<ul className="cancel-queue">{queue.items.map(item=><li key={item.id}>
      <div className="cancel-line"><b dir="ltr">{shortId(item.orderId)}</b><span>{item.requesterName||'—'}{item.requesterTail?` · *${item.requesterTail}`:''}</span><em>{statusLabel(item.orderStatus)} · {money(item.totalRial)}</em>{typeof item.refundCount==='number'&&item.refundCount>0&&<i className="cancel-chip">{fa(item.refundCount)} ردیف بازپرداخت</i>}</div>
      <p className="cancel-reason">{item.reason}</p>
      {item.note&&<p className="cancel-note">{item.note}{item.decidedBy?` · ${item.decidedBy}`:''} · {dateTime(item.decidedAt||item.createdAt)}</p>}
      {item.outcome==='PENDING'&&<div className="cancel-actions">
        <input value={notes[item.id]||''} onChange={e=>setNotes(current=>({...current,[item.id]:e.target.value}))} maxLength={300} placeholder="یادداشت برای مشتری (برای رد کردن لازم است)" aria-label={`یادداشت پاسخ به درخواست ${shortId(item.orderId)}`}/>
        <button className="approve-button" disabled={busy} onClick={()=>void answer(item,'ACCEPT')}><Check size={14}/>تأیید لغو</button>
        <button className="reject-button" disabled={busy} onClick={()=>void answer(item,'REJECT')}><X size={14}/>رد با دلیل</button>
      </div>}
      <button className="ledger-button" onClick={()=>void openLedger(item.orderId)}><Wallet size={13}/>دفتر بازپرداخت{item.paymentStatus==='REFUNDED'?' · بازپرداخت‌شده':''}</button>
    </li>)}</ul>}
    {total>10&&<div className="monitor-pager"><span>{fa(page+1)}–{fa(Math.min(page+10,total))} از {fa(total)} درخواست</span><div>
      <button className="pager-button" disabled={page<=0} onClick={()=>setPage(Math.max(0,page-10))}><ChevronRight size={14}/>قبلی</button>
      <button className="pager-button" disabled={page+10>=total} onClick={()=>setPage(page+10)}>بعدی<ChevronLeft size={14}/></button></div></div>}
    {ledger&&<div className="overlay" onClick={()=>setLedger(null)}><section className="ops-detail ledger-card" onClick={e=>e.stopPropagation()}>
      <button className="close" onClick={()=>setLedger(null)}><X size={18}/></button>
      <h2>دفتر بازپرداخت · <span dir="ltr">{shortId(ledger.orderId)}</span></h2>
      {ledger.data&&<div className="ledger-totals"><div><small>وصول‌شده</small><b>{money(ledger.data.collectedRial)}</b></div><div><small>بازگردانده‌شده</small><b>{money(ledger.data.refundedRial)}</b></div><div><small>جا مانده</small><b>{money(ledger.data.refundableRial)}</b></div></div>}
      {ledger.data&&ledger.data.items.length===0?<p className="queue-empty">هنوز ردیفی ثبت نشده است.</p>:<ul className="ledger-rows">{ledger.data?.items.map(row=><li key={row.id}><b className={row.kind==='CORRECTION'?'negative':''}>{row.kind==='CORRECTION'?'-':''}{money(row.amountRial.replace('-',''))}</b><span>{row.reason}</span><small>{row.fundedBy==='PLATFORM'?'پلتفرم':row.fundedBy==='BUSINESS'?'کسب‌وکار':'پیک'} · {row.destination==='WALLET'?'کیف پول':'قدیمی؛ مقصد نامشخص'} · {row.actorName} · {dateTime(row.createdAt)}</small></li>)}</ul>}
      <div className="ledger-form">
        <label><span>مبلغ (ریال)</span><input value={ledger.amount} onChange={e=>setLedger({...ledger,amount:e.target.value.replace(/[^\d-]/g,'').replace(/(?!^)-/g,'')})} inputMode="numeric" aria-label="مبلغ بازپرداخت به ریال"/></label>
        <label><span>بابت</span><select value={ledger.fundedBy} onChange={e=>setLedger({...ledger,fundedBy:e.target.value})} aria-label="طرف پرداخت‌کننده">{REFUND_PARTIES.map(party=><option key={party.value} value={party.value}>{party.label}</option>)}</select></label>
        <label className="wide"><span>دلیل</span><input value={ledger.reason} onChange={e=>setLedger({...ledger,reason:e.target.value})} maxLength={300} aria-label="دلیل بازپرداخت"/></label>
        <button className="primary-button" disabled={ledger.busy||!ledger.amount||!ledger.reason} onClick={()=>void addRefund()}>{ledger.busy?'در حال ثبت…':'ثبت ردیف'}</button>
        <small>بازپرداخت مثبت به کیف پول مشتری می‌رود و سقف آن وجه وصول‌شده است؛ برای اصلاح اعتبار کیف پول همین سفارش مبلغ منفی بنویسید. بازپرداخت‌های قدیمی مقصد مشخصی ندارند و خودکار به کیف پول اضافه نشده‌اند. اگر پاسخ ثبت نامشخص بود، همان درخواست را دوباره ارسال کنید.</small>
      </div>
    </section></div>}
    <div className="policy-editor">
      <h3>قوانین لغو سفارش</h3>
      <p>هر وضعیتی که اینجا انتخاب شود، به مشتری اجازه می‌دهد بدون تأیید کادر لغو کند. بازهٔ زمانی هم روی همان وضعیت‌ها اعمال می‌شود.</p>
      <div className="policy-statuses">{STATUS_OPTIONS.map(option=>{const checked=policy?.autoCancelStatuses.includes(option.value)??false;return <label key={option.value}><input type="checkbox" checked={checked} disabled={!policy||busy} onChange={()=>{ if(!policy) return; const next=checked?policy.autoCancelStatuses.filter(value=>value!==option.value):[...policy.autoCancelStatuses,option.value]; void savePolicy({...policy,autoCancelStatuses:next.length?next:['PENDING_BUSINESS']}); }}/>{option.label}</label>;})}</div>
      <div className="policy-window"><span>بازهٔ مجاز (دقیقه) · ۰ یعنی بدون محدودیت زمانی</span><label className="money-input"><input aria-label="بازهٔ مجاز لغو به دقیقه" value={policy?String(policy.windowMinutes):''} disabled={!policy||busy} onChange={e=>{ if(policy) void savePolicy({...policy,windowMinutes:Number(e.target.value.replace(/\D/g,'')||0)}); }} inputMode="numeric"/><span>دقیقه</span></label></div>
    </div>
  </section>;
}
