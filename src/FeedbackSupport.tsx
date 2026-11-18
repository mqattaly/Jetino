import { useCallback, useEffect, useState } from 'react';
import { Check, ChevronLeft, ChevronRight, MessageSquarePlus, RefreshCw, Star, Trash2, X } from 'lucide-react';

type Feedback = { id:string; orderId:string; orderCode:string; businessRating:number; driverRating:number|null; comment:string|null; createdAt:string; updatedAt:string; authorName?:string|null; businessName?:string|null };
type BusinessReport = { feedbackCount:number; averageBusinessRating:number|null; averageDriverRating:number|null; needsAttention:number; items:Feedback[] };
type DriverReport = { feedbackCount:number; averageDriverRating:number|null; items:Feedback[] };
type StaffReport = { items:Feedback[]; limit:number; offset:number; totalMatches:number };
type Ticket = { id:string; orderId:string|null; status:string; createdAt:string; updatedAt:string; messageCount:number; lastMessage:string|null; mine?:boolean; authorName?:string|null; authorTail?:string|null; businessName?:string|null };
type TicketPage = { items:Ticket[]; limit:number; offset:number; totalMatches:number; counts?:Record<string,number> };
type Thread = { id:string; orderId:string|null; status:string; createdAt:string; updatedAt:string; mine:boolean; canReply:boolean; canChangeStatus:boolean;
  messages:Array<{ id:string; body:string; fromStaff:boolean; createdAt:string; authorName:string }>;
  events:Array<{ fromStatus:string|null; toStatus:string; note:string|null; createdAt:string; actorName:string }> };

const MAX_COMMENT=500;
const MAX_BODY=1000;
const TRANSITIONS:Record<string,string[]>={ OPEN:['IN_REVIEW','RESOLVED','CLOSED'], IN_REVIEW:['RESOLVED','CLOSED'], RESOLVED:['IN_REVIEW','CLOSED'], CLOSED:[] };
const statusLabel=(status:string)=>({ OPEN:'باز', IN_REVIEW:'در حال بررسی', RESOLVED:'حل‌شده', CLOSED:'بسته‌شده' } as Record<string,string>)[status]||status;
const fa=(value:number|string)=>new Intl.NumberFormat('fa-IR').format(Number(value));
const dateTime=(value:string)=>new Intl.DateTimeFormat('fa-IR-u-ca-persian',{dateStyle:'short',timeStyle:'short'}).format(new Date(value));
const shortId=(value:string|null)=>value?`${value.slice(0,8).toUpperCase()}`:'—';

/** Same shape as the other panels: a JSON error body is the only reliable failure text. */
async function request<T>(path:string, token:string, init?:RequestInit):Promise<T>{
  const response=await fetch(path,{...init,headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`,...(init?.headers||{})}});
  const data=((await response.json().catch(()=>({})))??{}) as T&{message?:string};
  if(!response.ok) throw new Error(typeof data.message==='string'?data.message:`خطا (${response.status})`);
  return data;
}

function StarPicker({name,value,onChange,hint}:{name:string;value:number;onChange:(next:number)=>void;hint?:string}){
  return <div className="star-field"><b className="star-label">{name}</b><div className="stars">
    {[1,2,3,4,5].map(step=><button type="button" key={step} className={step<=value?'star on':'star'} aria-label={`${fa(step)} ستاره`} aria-pressed={step===value} onClick={()=>onChange(step)}><Star size={15} fill={step<=value?'currentColor':'none'}/></button>)}
  </div><small className="star-hint">{hint}</small></div>;
}

function FeedbackRow({row,showAuthor,showBusiness}:{row:Feedback;showAuthor?:boolean;showBusiness?:boolean}){
  return <div className="fb-row"><div><b>{fa(row.businessRating)} ستاره به {showBusiness?'فروشگاه':'کسب‌وکار'}{row.driverRating?` · ${fa(row.driverRating)} ستاره به پیک`:''}</b><p>{row.comment||'بدون توضیح نوشته شد.'}</p><time>سفارش {row.orderCode} · {dateTime(row.createdAt)}{showAuthor&&row.authorName?` · ${row.authorName}`:''}{showBusiness&&row.businessName?` · ${row.businessName}`:''}</time></div></div>;
}

/** A rating belongs to a delivered order and to the customer who received it. */
export function OrderFeedbackPanel({token,orderId,hasDriver,onSaved}:{token:string;orderId:string;hasDriver?:boolean;onSaved?:()=>void}){
  const [business,setBusiness]=useState(0); const [driver,setDriver]=useState(0); const [comment,setComment]=useState('');
  const [loading,setLoading]=useState(true); const [busy,setBusy]=useState(false); const [error,setError]=useState(''); const [notice,setNotice]=useState('');
  const [existing,setExisting]=useState<'none'|'own'|'other'>('none');
  useEffect(()=>{
    let alive=true; setLoading(true); setError('');
    void request<Feedback|null>(`/api/v1/orders/${orderId}/feedback`,token)
      .then(row=>{ if(!alive) return; if(row){ setBusiness(row.businessRating); setDriver(row.driverRating??0); setComment(row.comment||''); setExisting('own'); } else setExisting('none'); })
      .catch(e=>{ if(alive) setError((e as Error).message); })
      .finally(()=>{ if(alive) setLoading(false); });
    return ()=>{ alive=false; };
  },[orderId,token]);
  const save=async()=>{
    if(business<1){ setError('برای ثبت بازخورد، اول به کسب‌وکار امتیاز بدهید.'); return; }
    setBusy(true); setError(''); setNotice('');
    try{
      await request(`/api/v1/orders/${orderId}/feedback`,token,{method:'PUT',body:JSON.stringify({ businessRating:business, ...(driver?{driverRating:driver}:{}), comment:comment.trim() })});
      setExisting('own'); setNotice(existing==='none'?'بازخورد شما ثبت شد؛ کمک بزرگی به ما کردید.':'بازخورد شما اصلاح شد.'); onSaved?.();
    }catch(e){ setError((e as Error).message); } finally{ setBusy(false); }
  };
  return <div className="fb-form">{loading?<div className="queue-empty">در حال خواندن بازخورد این سفارش…</div>:<>
    {existing==='other'&&<div className="feedback error" role="alert">این سفارش بازخوردی ثبت کرده که فقط نویسنده‌اش می‌تواند آن را ویرایش کند.</div>}
    <StarPicker name="امتیاز به کسب‌وکار" value={business} onChange={setBusiness} hint={business?`${fa(business)} از ${fa(5)}`:'لازم است'}/>
    <StarPicker name="امتیاز به پیک" value={driver} onChange={next=>setDriver(next===driver?0:next)} hint={hasDriver===false?'این سفارش پیک تخصیص‌یافته نداشت.':driver?'برای حذف، همان ستاره را دوباره بزنید.':'اختیاری'}/>
    <label className="checkout-label" htmlFor={`fb-comment-${orderId}`}>توضیح شما (اختیاری)</label>
    <textarea id={`fb-comment-${orderId}`} className="fb-textarea" maxLength={MAX_COMMENT} value={comment} onChange={e=>setComment(e.target.value)} placeholder="چی خوب بود و چی باید بهتر می‌شد؟"/>
    <div className="fb-counter">{fa(comment.trim().length)} از {fa(MAX_COMMENT)} نویسه</div>
    {error&&<div className="feedback error" role="alert">{error}</div>}{notice&&<div className="feedback success" role="status">{notice}</div>}
    <div className="fb-actions"><button className="approve-button" disabled={busy||existing==='other'} onClick={()=>void save()}><Check size={14}/>{busy?'در حال ذخیره…':existing==='none'?'ثبت بازخورد':'ذخیرهٔ تغییرات'}</button></div>
    <p className="fb-note">بازخورد پس از تحویل ثبت می‌شود و هر بار که آن را اصلاح کنید، همان یک نظر جای قبلی را می‌گیرد؛ پس میانگین امتیازها دست‌کاری‌پذیر نمی‌شود.</p>
  </>}</div>;
}

function ReportSummary({average,count,attention}:{average:number|null;count:number;attention?:number}){
  return <div className="fb-summary">
    <div><small>میانگین امتیاز</small><b>{average===null?'—':`${new Intl.NumberFormat('fa-IR',{maximumFractionDigits:2}).format(average)} از ۵`}</b></div>
    <div><small>بازخورد ثبت‌شده</small><b>{fa(count)}</b></div>
    {attention!==undefined&&<div><small>نیازمند توجه</small><b>{fa(attention)}</b><i>{attention>0?'امتیاز دو یا یک ستاره':'مورد باز‌مانده‌ای نیست'}</i></div>}
  </div>;
}

export function BusinessFeedbackPanel({token}:{token:string}){
  const [report,setReport]=useState<BusinessReport|null>(null); const [loading,setLoading]=useState(true); const [error,setError]=useState('');
  const load=useCallback(async()=>{
    setLoading(true); setError('');
    try{
      const mine=await request<Array<{id:string;status:string}>>('/api/v1/businesses/mine',token);
      const business=mine.find(item=>item.status==='ACTIVE')||mine[0];
      if(!business){ setReport(null); return; }
      setReport(await request<BusinessReport>(`/api/v1/feedback/businesses/${business.id}?limit=6`,token));
    }catch(e){ setError((e as Error).message); } finally{ setLoading(false); }
  },[token]);
  useEffect(()=>{ void load(); },[load]);
  return <section className="admin-card feedback-card">
    <div className="queue-heading"><div><span className="setting-icon"><Star size={18}/></span><div><h2>بازخورد مشتریان</h2><small>میانگین امتیازها و آخرین نظرها روی سفارش‌های تحویل‌شده</small></div></div><button className="refresh-button" disabled={loading} onClick={()=>void load()}><RefreshCw size={14}/>تازه‌سازی</button></div>
    {error&&<div className="feedback error" role="alert">{error}</div>}
    {loading&&!report?<div className="queue-empty">در حال دریافت بازخوردها…</div>:!report?<div className="queue-empty">کسب‌وکاری برای این حساب ثبت نشده است.</div>:<>
      <ReportSummary average={report.averageBusinessRating} count={report.feedbackCount} attention={report.needsAttention}/>
      {report.items.length===0?<div className="queue-empty">هنوز بازخوردی روی سفارش‌های شما ثبت نشده است.</div>:<div className="fb-list">{report.items.map(row=><FeedbackRow key={row.id} row={row} showAuthor/>)}</div>}
    </>}
  </section>;
}

export function DriverFeedbackPanel({token}:{token:string}){
  const [report,setReport]=useState<DriverReport|null>(null); const [loading,setLoading]=useState(true); const [error,setError]=useState('');
  const load=useCallback(async()=>{
    setLoading(true); setError('');
    try{ setReport(await request<DriverReport>('/api/v1/feedback/drivers/me?limit=6',token)); }
    catch(e){ setError((e as Error).message); } finally{ setLoading(false); }
  },[token]);
  useEffect(()=>{ void load(); },[load]);
  return <section className="admin-card feedback-card">
    <div className="queue-heading"><div><span className="setting-icon"><Star size={18}/></span><div><h2>امتیاز تحویل‌ها</h2><small>فقط امتیازی که مشتریان به خودِ رانندگی شما داده‌اند</small></div></div><button className="refresh-button" disabled={loading} onClick={()=>void load()}><RefreshCw size={14}/>تازه‌سازی</button></div>
    {error&&<div className="feedback error" role="alert">{error}</div>}
    {loading&&!report?<div className="queue-empty">در حال دریافت امتیازها…</div>:!report||report.feedbackCount===0?<div className="queue-empty">هنوز امتیازی برای شما ثبت نشده است.</div>:<>
      <ReportSummary average={report.averageDriverRating} count={report.feedbackCount}/>
      <div className="fb-list">{report.items.map(row=><FeedbackRow key={row.id} row={row}/>)}</div>
    </>}
  </section>;
}

export function TicketThread({token,ticketId,staff,onBack,onChanged}:{token:string;ticketId:string;staff?:boolean;onBack:()=>void;onChanged?:()=>void}){
  const [thread,setThread]=useState<Thread|null>(null); const [error,setError]=useState(''); const [busy,setBusy]=useState(false);
  const [reply,setReply]=useState(''); const [target,setTarget]=useState(''); const [note,setNote]=useState('');
  const load=useCallback(async()=>{
    setError('');
    try{ const row=await request<Thread>(`/api/v1/support/tickets/${ticketId}`,token); setThread(row); setTarget((staff?TRANSITIONS[row.status]:(TRANSITIONS[row.status]||[]).filter(status=>status==='CLOSED'))[0]||''); }
    catch(e){ setError((e as Error).message); }
  },[ticketId,token,staff]);
  useEffect(()=>{ void load(); },[load]);
  const send=async()=>{
    if(reply.trim().length<2){ setError('پاسخ خالی نمی‌تواند ثبت شود.'); return; }
    setBusy(true); setError('');
    try{ await request(`/api/v1/support/tickets/${ticketId}/messages`,token,{method:'POST',body:JSON.stringify({message:reply.trim()})}); setReply(''); await load(); onChanged?.(); }
    catch(e){ setError((e as Error).message); } finally{ setBusy(false); }
  };
  const move=async()=>{
    if(!target) return;
    setBusy(true); setError('');
    try{ await request(`/api/v1/support/tickets/${ticketId}/status`,token,{method:'PATCH',body:JSON.stringify({status:target,note:note.trim()})}); setNote(''); await load(); onChanged?.(); }
    catch(e){ setError((e as Error).message); await load(); } finally{ setBusy(false); }
  };
  const choices=thread?(staff?TRANSITIONS[thread.status]||[]:(TRANSITIONS[thread.status]||[]).filter(status=>status==='CLOSED')):[];
  return <section className="admin-card thread-card">
    <div className="queue-heading"><div><span className="setting-icon"><MessageSquarePlus size={18}/></span><div><h2>گفت‌وگوی گزارش</h2><small>{thread?`${statusLabel(thread.status)} · ${fa(thread.messages.length)} پیام · آخرین فعالیت ${dateTime(thread.updatedAt)}`:'…'}</small></div></div><button className="refresh-button" onClick={onBack}><X size={14}/>بازگشت به فهرست</button></div>
    {error&&<div className="feedback error" role="alert">{error}</div>}
    {!thread?<div className="queue-empty">در حال خواندن گفت‌وگو…</div>:<>
      {thread.orderId&&<p className="fb-note">به سفارش <b dir="ltr">{shortId(thread.orderId)}</b> مربوط است.</p>}
      <div className="thread">{thread.messages.map(message=><div key={message.id} className={message.fromStaff?'thread-msg staff':'thread-msg'}><span>{message.body}</span><small>{message.fromStaff?'پشتیبانی جتینو':message.authorName} · {dateTime(message.createdAt)}</small></div>)}</div>
      {thread.canReply?<><label className="checkout-label" htmlFor={`reply-${ticketId}`}>پاسخ شما</label><textarea id={`reply-${ticketId}`} className="fb-textarea" maxLength={MAX_BODY} value={reply} onChange={e=>setReply(e.target.value)} placeholder="هر نکته‌ای که به بررسی کمک می‌کند بنویسید."/><div className="fb-actions"><button className="approve-button" disabled={busy||reply.trim().length<2} onClick={()=>void send()}><Check size={14}/>ارسال پاسخ</button><span className="fb-counter">{fa(reply.trim().length)} از {fa(MAX_BODY)} نویسه</span></div></>
        :<p className="fb-note">این گفت‌وگو بسته شده و پیام جدید پذیرفته نمی‌شود. اگر مشکل دوباره پیش آمد، گزارش تازه‌ای ثبت کنید.</p>}
      {choices.length>0&&<div className="thread-status">
        <label className="checkout-label" htmlFor={`status-${ticketId}`}>{thread.canChangeStatus?'تغییر وضعیت':'وضعیت فقط توسط کادر پشتیبانی تغییر می‌کند'}</label>
        <div className="thread-status-row">
          <select id={`status-${ticketId}`} className="prep-select" disabled={!thread.canChangeStatus||busy} value={target} onChange={e=>setTarget(e.target.value)}>{choices.map(status=><option key={status} value={status}>{statusLabel(status)}</option>)}</select>
          {thread.canChangeStatus&&<input className="checkout-input thread-note" value={note} disabled={busy} onChange={e=>setNote(e.target.value)} placeholder={target==='RESOLVED'?'چه چیزی انجام شد؟ (لازم است)':'دلیل یا نکته (اختیاری)'}/>}
          {thread.canChangeStatus&&<button className="reject-button" disabled={busy||!target} onClick={()=>void move()}>ثبت وضعیت</button>}
        </div>
      </div>}
      {thread.events.length>0&&<details className="thread-events"><summary>سابقهٔ وضعیت ({fa(thread.events.length)})</summary>{thread.events.map((event,index)=><p key={index}>{event.fromStatus?`${statusLabel(event.fromStatus)} ← `:''}{statusLabel(event.toStatus)} · {event.actorName} · {dateTime(event.createdAt)}{event.note?` · ${event.note}`:''}</p>)}</details>}
    </>}
  </section>;
}

/** The reporter's inbox, and — with `staff` — the operations queue on top of it. */
export function SupportPanel({token,staff,orders}:{token:string;staff?:boolean;orders?:Array<{id:string;label:string}>}){
  const [page,setPage]=useState<TicketPage|null>(null); const [status,setStatus]=useState(staff?'OPEN':''); const [search,setSearch]=useState(''); const [applied,setApplied]=useState('');
  const [loading,setLoading]=useState(false); const [error,setError]=useState(''); const [notice,setNotice]=useState('');
  // a notification points at the thread it is about, so opening one must land inside it
  const [open,setOpen]=useState<string|null>(()=>new URLSearchParams(window.location.search).get('ticketId')); const [creating,setCreating]=useState(false);
  const [draft,setDraft]=useState(''); const [draftOrder,setDraftOrder]=useState(''); const [busy,setBusy]=useState(false);
  const load=useCallback(async(offset=0)=>{
    setLoading(true); setError('');
    const query=new URLSearchParams({limit:'10',offset:String(offset)});
    if(status) query.set('status',status);
    if(staff&&applied) query.set('search',applied);
    const listPath=staff?'/api/v1/support/tickets/admin/queue':'/api/v1/support/tickets/mine';
    try{ setPage(await request<TicketPage>(`${listPath}?${query.toString()}`,token)); }
    catch(e){ setError((e as Error).message); } finally{ setLoading(false); }
  },[token,staff,status,applied]);
  useEffect(()=>{ if(open) return; void load(0); },[load,open]);
  const closeThread=()=>{ setOpen(null); if(window.location.search.includes('ticketId')) window.history.replaceState(null,'',window.location.pathname); };
  const create=async()=>{
    if(draft.trim().length<5){ setError('برای ثبت گزارش، مشکل را کامل‌تر بنویسید (حداقل ۵ نویسه).'); return; }
    setBusy(true); setError(''); setNotice('');
    try{ const ticket=await request<{id:string}>('/api/v1/support/tickets',token,{method:'POST',body:JSON.stringify({message:draft.trim(),...(draftOrder?{orderId:draftOrder}:{})})}); setDraft(''); setDraftOrder(''); setCreating(false); setNotice('گزارش شما ثبت شد و به کادر پشتیبانی رسید.'); setOpen(ticket.id); }
    catch(e){ setError((e as Error).message); } finally{ setBusy(false); }
  };
  if(open) return <TicketThread token={token} ticketId={open} staff={staff} onBack={closeThread} onChanged={()=>void load(page?.offset??0)}/>;
  const offset=page?.offset??0;
  return <section className="admin-card support-card">
    <div className="queue-heading"><div><span className="setting-icon"><MessageSquarePlus size={18}/></span><div><h2>{staff?'صف پشتیبانی':'گزارش‌های من'}</h2><small>{staff?'گزارش‌های باز را از قدیمی‌ترین بررسی کنید؛ هر پاسخ، مشتری را باخبر می‌کند.':'مشکل سفارش یا حساب را اینجا بنویسید؛ گفت‌وگو همین‌جا ادامه پیدا می‌کند.'}</small></div></div>
      <button className="refresh-button" disabled={loading} onClick={()=>void load(offset)}><RefreshCw size={14}/>{loading?'…':'تازه‌سازی'}</button></div>
    {staff&&<div className="queue-tabs">{['OPEN','IN_REVIEW','RESOLVED','CLOSED',''].map(value=><button key={value||'ALL'} type="button" className={status===value?'on':''} onClick={()=>setStatus(value)}>{value?statusLabel(value):'همه'}{page?.counts?.[value]!==undefined?` (${fa(page.counts[value])})`:''}</button>)}</div>}
    {staff&&<div className="support-search"><input className="checkout-input" value={search} onChange={e=>setSearch(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();setApplied(search.trim());}}} placeholder="جست‌وجو با شمارهٔ گزارش، نام یا شمارهٔ سفارش‌دهنده" aria-label="جست‌وجو در گزارش‌ها"/><button className="refresh-button" disabled={loading} onClick={()=>setApplied(search.trim())}>جست‌وجو</button>{applied&&<span className="fb-counter">نتیجهٔ «{applied}»</span>}</div>}
    {error&&<div className="feedback error" role="alert">{error}</div>}{notice&&<div className="feedback success" role="status">{notice}</div>}
    {!staff&&(creating?<div className="support-new">
      <label className="checkout-label" htmlFor="support-message">مشکل را بنویسید</label>
      <textarea id="support-message" className="fb-textarea" maxLength={MAX_BODY} value={draft} onChange={e=>setDraft(e.target.value)} placeholder="مثلاً: سفارش تحویل داده نشده ولی در اپ «تحویل‌شده» خورده است."/>
      {orders&&orders.length>0&&<><label className="checkout-label" htmlFor="support-order">ربط به سفارش (اختیاری)</label><select id="support-order" className="prep-select" value={draftOrder} onChange={e=>setDraftOrder(e.target.value)}><option value="">بدون سفارش مشخص</option>{orders.map(order=><option key={order.id} value={order.id}>{order.label}</option>)}</select></>}
      <div className="fb-actions"><button className="approve-button" disabled={busy||draft.trim().length<5} onClick={()=>void create()}><Check size={14}/>{busy?'در حال ثبت…':'ثبت گزارش'}</button><button className="text-button" onClick={()=>{setCreating(false);setDraft('');setError('');}}>انصراف</button></div>
    </div>:<div className="support-new"><button className="primary-button" onClick={()=>setCreating(true)}><MessageSquarePlus size={16}/>ثبت گزارش جدید</button></div>)}
    {page&&page.items.length===0?<div className="queue-empty">{staff?'گزارش بازی در این وضعیت نیست.':(page.totalMatches===0?'هنوز گزارشی ثبت نکرده‌اید.':'در این وضعیت گزارشی نیست.')}</div>
      :page&&<div className="ticket-list">{page.items.map(row=><button type="button" className="ticket-row" key={row.id} onClick={()=>setOpen(row.id)}>
        <div><b>{statusLabel(row.status)}{row.mine===false?' · هم‌رسانی':''}</b><small>{row.orderId?`سفارش ${shortId(row.orderId)} · `:''}{fa(row.messageCount)} پیام · {dateTime(row.updatedAt)}</small>{row.lastMessage&&<p>{row.lastMessage}</p>}</div>
        <div className="ticket-side">{staff&&<span>{row.authorName||'—'}{row.authorTail?` · ···${row.authorTail}`:''}</span>}{row.businessName? <span>{row.businessName}</span>:null}</div>
        <span className="pager-hint">باز کردن</span>
      </button>)}</div>}
    {page&&page.totalMatches>page.items.length&&<div className="monitor-pager"><span>{fa(offset+1)}–{fa(offset+page.items.length)} از {fa(page.totalMatches)} گزارش</span><div>
      <button className="pager-button" disabled={loading||offset<=0} onClick={()=>void load(Math.max(0,offset-(page.limit||10)))}><ChevronRight size={14}/>قبلی</button>
      <button className="pager-button" disabled={loading||offset+(page.limit||10)>=page.totalMatches} onClick={()=>void load(offset+(page.limit||10))}>بعدی<ChevronLeft size={14}/></button></div></div>}
  </section>;
}

/** Staff-only: reading the corpus, and deleting one entry with a reason that is itself logged. */
export function AdminFeedbackBoard({token}:{token:string}){
  const [report,setReport]=useState<StaffReport|null>(null); const [maxStars,setMaxStars]=useState(''); const [loading,setLoading]=useState(false);
  const [error,setError]=useState(''); const [notice,setNotice]=useState(''); const [busy,setBusy]=useState(false);
  const load=useCallback(async()=>{
    setLoading(true); setError('');
    const query=new URLSearchParams({limit:'15'}); if(maxStars) query.set('maxStars',maxStars);
    try{ setReport(await request<StaffReport>(`/api/v1/feedback/admin?${query.toString()}`,token)); }
    catch(e){ setError((e as Error).message); } finally{ setLoading(false); }
  },[token,maxStars]);
  useEffect(()=>{ void load(); },[load]);
  const remove=async(row:Feedback)=>{
    const reason=window.prompt(`دلیل حذف بازخورد سفارش ${row.orderCode} را بنویسید (در سابقهٔ ممیزی ثبت می‌شود):`);
    if(reason===null) return;
    if(reason.trim().length<3){ setError('برای حذف، دلیل کوتاه اما واضح لازم است.'); return; }
    setBusy(true); setError(''); setNotice('');
    try{ await request(`/api/v1/feedback/admin/${row.id}`,token,{method:'DELETE',body:JSON.stringify({reason:reason.trim()})}); setNotice('بازخورد حذف شد و میانگین امتیازها دوباره محاسبه می‌شود.'); await load(); }
    catch(e){ setError((e as Error).message); } finally{ setBusy(false); }
  };
  return <section className="admin-card feedback-card">
    <div className="queue-heading"><div><span className="setting-icon"><Trash2 size={18}/></span><div><h2>بازخورد سفارش‌ها</h2><small>نظرات ثبت‌شده روی کل پلتفرم · حذف فقط با دلیل و در سجل ممیزی</small></div></div>
      <div className="report-controls"><select aria-label="فیلتر سقف امتیاز" value={maxStars} disabled={loading} onChange={e=>setMaxStars(e.target.value)}><option value="">همهٔ امتیازها</option><option value="1">تا ۱ ستاره</option><option value="2">تا ۲ ستاره</option><option value="3">تا ۳ ستاره</option></select><button className="refresh-button" disabled={loading} onClick={()=>void load()}><RefreshCw size={14}/>{loading?'…':'تازه‌سازی'}</button></div></div>
    {error&&<div className="feedback error" role="alert">{error}</div>}{notice&&<div className="feedback success" role="status">{notice}</div>}
    {report&&report.items.length===0?<div className="queue-empty">بازخوردی با این فیلترها ثبت نشده است.</div>
      :report&&<div className="fb-list">{report.items.map(row=><div className="fb-row moderation" key={row.id}><div><b>{fa(row.businessRating)} ستاره به {row.businessName||'—'}{row.driverRating?` · پیک ${fa(row.driverRating)}`:' · بدون امتیاز پیک'}</b><p>{row.comment||'بدون توضیح'}</p><time>{row.businessName||'—'} · سفارش {row.orderCode} · {dateTime(row.createdAt)}</time></div><button className="reject-button" disabled={busy} onClick={()=>void remove(row)}><Trash2 size={13}/>حذف</button></div>)}</div>}
  </section>;
}
