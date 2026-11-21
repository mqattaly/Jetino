import { useEffect,useState } from 'react';
import { SkeletonList } from './ui/motion';
import { ArrowLeft, Bell, BellOff, CheckCheck, Settings2 } from 'lucide-react';
import { BackButton } from './ui/controls';
import { OtpLogin } from './OperationsApp';
type Notice={id:string;eventType:string;title:string;body:string;data:Record<string,string>;dedupeKey:string|null;readAt:string|null;createdAt:string;pushState:PushState;pushError:string|null};
type PushState='NONE'|'PENDING'|'SENT'|'FAILED'|'SKIPPED';
type ApiResponse={items:Notice[];unreadCount:number};
type PushConfig={configured:boolean;vapidReady:boolean;publicKey:string|null};
type Preference={key:string;enabled:boolean;partiallyMuted:boolean};
// the ledger state is operator detail; the customer only needs to know whether the phone was reached
const pushLabels:Record<PushState,{text:string;className:string}>={
 NONE:{text:'',className:''},PENDING:{text:'در صف ارسال',className:'pending'},SENT:{text:'روی گوشی ارسال شد',className:'sent'},
 FAILED:{text:'ارسال نشد',className:'failed'},SKIPPED:{text:'اعلان مرورگر فعال نیست',className:'skipped'},
};
const date=(value:string)=>new Intl.DateTimeFormat('fa-IR-u-ca-persian',{dateStyle:'medium',timeStyle:'short'}).format(new Date(value));
async function api<T>(path:string,token:string,method='GET',body?:unknown):Promise<T>{
 const r=await fetch(path,{method,headers:{Authorization:`Bearer ${token}`,...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});
 const data=await r.json().catch(()=>({})) as T&{message?:string};if(!r.ok)throw new Error(data.message||`خطا (${r.status})`);return data;
}
const pushSupported=()=>typeof window!=='undefined'&&'PushManager' in window&&'serviceWorker' in navigator;
// the browser hands us a base64url VAPID key, but pushManager wants raw bytes
export default function NotificationApp(){const[token,setToken]=useState(()=>sessionStorage.getItem('jetino_customer_token')||'');const[items,setItems]=useState<Notice[]>([]);const[unread,setUnread]=useState(0);const[busy,setBusy]=useState(false);const[error,setError]=useState('');
 const[config,setConfig]=useState<PushConfig|null>(null);const[subscribed,setSubscribed]=useState(false);const[groups,setGroups]=useState<Preference[]>([]);const[showPrefs,setShowPrefs]=useState(false);const[pushNote,setPushNote]=useState('');
 useEffect(()=>{document.title='اعلان‌ها | جتینو';if(token){void load(token);void loadPush(token);}},[]);
 const load=async(auth=token)=>{setBusy(true);setError('');try{const result=await api<ApiResponse>('/api/v1/notifications',auth);setItems(result.items);setUnread(result.unreadCount);}catch(e){setError((e as Error).message);}finally{setBusy(false);}};
 const loadPush=async(auth:string)=>{
  if(!pushSupported())return;
  try{
   const cfg=await api<PushConfig>('/api/v1/notifications/push/config',auth);setConfig(cfg);
   if(!cfg.configured)return;
   const mine=await api<{items:{active:boolean}[]}>('/api/v1/notifications/push/subscriptions',auth);
   setSubscribed(mine.items.some(item=>item.active));
   const prefs=await api<{groups:Preference[]}>('/api/v1/notifications/push/preferences',auth);setGroups(prefs.groups);
  }catch{ /* the panel still works without push; the inbox is the source of truth */ }
 };
 const login=(auth:string)=>{sessionStorage.setItem('jetino_customer_token',auth);setToken(auth);void load(auth);void loadPush(auth);};
 const mark=async(item:Notice)=>{if(item.readAt)return;try{await api(`/api/v1/notifications/${item.id}/read`,token,'PATCH');setItems(current=>current.map(x=>x.id===item.id?{...x,readAt:new Date().toISOString()}:x));setUnread(n=>Math.max(0,n-1));}catch(e){setError((e as Error).message);}};
 // every notification names the screen that can act on it, so the customer is never dropped on a panel they cannot use
 const destinations:Record<string,{path:string;key:'orderId'|'ticketId'|'storeId'}>={
  DELIVERY_ASSIGNED:{path:'/driver/deliveries',key:'orderId'},DRIVER_FEEDBACK:{path:'/driver/deliveries',key:'orderId'},
  ORDER_NEW:{path:'/business/orders',key:'orderId'},ORDER_CANCELLED:{path:'/business/orders',key:'orderId'},ORDER_FEEDBACK:{path:'/business/orders',key:'orderId'},
  ORDER_CANCELLATION_REQUEST:{path:'/business/orders',key:'orderId'},ORDER_CANCELLATION_REVIEW:{path:'/admin',key:'orderId'},ORDER_CANCELLATION_DECIDED:{path:'/orders',key:'orderId'},ORDER_REFUNDED:{path:'/orders',key:'orderId'},
  GROCERY_STORE_STATUS:{path:'/grocery/store',key:'storeId'},
  SUPPORT_TICKET_OPENED:{path:'/orders',key:'ticketId'},SUPPORT_TICKET_MESSAGE:{path:'/orders',key:'ticketId'},SUPPORT_TICKET_RESOLVED:{path:'/orders',key:'ticketId'},
 };
 const openNotice=async(item:Notice)=>{
  await mark(item);
  const target=destinations[item.eventType];if(!target)return;
  const value=item.data?.[target.key];if(!value)return;
  // the courier screens take the id in the path, everything else deep-links with a query
  window.location.assign(target.path==='/driver/deliveries'?target.path:`${target.path}?${target.key}=${encodeURIComponent(value)}`);
 };
 const readAll=async()=>{setBusy(true);setError('');try{await api('/api/v1/notifications/read-all',token,'POST');setItems(current=>current.map(x=>({...x,readAt:x.readAt||new Date().toISOString()})));setUnread(0);}catch(e){setError((e as Error).message);}finally{setBusy(false);}};
 const registration=async()=>{const scope=await navigator.serviceWorker.getRegistration('/');return scope ?? navigator.serviceWorker.register('/sw.js');};
 const enablePush=async()=>{
  if(!config?.publicKey||!token)return;setPushNote('');setError('');
  try{
   const sw=await registration();
   if(!sw)throw new Error('سرویس کارگر در دسترس نیست.');
   const sub=await sw.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:applicationKey(config.publicKey)});
   const json=sub.toJSON() as {endpoint:string;keys?:{p256dh?:string;auth?:string}};
   await api('/api/v1/notifications/push/subscription',token,'POST',{endpoint:json.endpoint,p256dh:json.keys?.p256dh??'',auth:json.keys?.auth??'',userAgent:navigator.userAgent.slice(0,200)});
   setSubscribed(true);setPushNote('اعلان مرورگر فعال شد.');
  }catch(e){setError((e as Error).message);}
 };
 const disablePush=async()=>{
  if(!token)return;setError('');
  try{
   const sw=await registration();const sub=await sw?.pushManager.getSubscription();
   const endpoint=sub?.endpoint??'';
   await sw?.pushManager.getSubscription().then(current=>current?.unsubscribe());
   if(endpoint)await api('/api/v1/notifications/push/subscription',token,'DELETE',{endpoint});
   setSubscribed(false);setPushNote('اعلان مرورگر خاموش شد.');
  }catch(e){setError((e as Error).message);}
 };
 const toggleGroup=async(key:string,enabled:boolean)=>{
  if(!token)return;const next=groups.map(group=>group.key===key?{...group,enabled,partiallyMuted:false}:group);setGroups(next);setError('');
  try{// PUT carries the whole wish list, so the server can tell "off" from "not mentioned"
   await api('/api/v1/notifications/push/preferences',token,'PUT',{groups:next.filter(group=>group.enabled).map(group=>group.key)});
  }catch(e){setError((e as Error).message);void loadPush(token);}
 };
 const label=(state:string)=>pushLabels[state as PushState]??pushLabels.NONE;
 return <div className="ops-page" dir="rtl"><header className="ops-header"><a href="/" className="brand"><span className="brand-mark">ج</span><span>جتینو<small>مرکز اعلان‌ها</small></span></a></header><main className="ops-main"><BackButton /><div className="ops-title"><div><div className="eyebrow muted">به‌روز بمان</div><h1>اعلان‌های من</h1><p>تغییر وضعیت سفارش‌ها و رویدادهای مهم حساب.</p></div>{token&&<div className="notification-actions"><button className="refresh-button" disabled={busy} onClick={()=>void load()}><Bell size={14}/>{busy?'در حال بررسی…':'به‌روزرسانی'}</button>{unread>0&&<button className="refresh-button" disabled={busy} onClick={()=>void readAll()}><CheckCheck size={14}/>خواندن همه</button>}{pushSupported()&&config?.configured&&<button className="refresh-button" onClick={()=>setShowPrefs(current=>!current)}><Settings2 size={14}/>انتخاب رویدادها</button>}</div>}</div>{error&&<div className="feedback error" role="alert">{error}</div>}{!token?<OtpLogin onSuccess={login} onError={setError}/>:<>{token&&pushSupported()&&(config?.configured?<div className="push-panel"><div><b>{subscribed?'اعلان روی این دستگاه روشن است':'اعلان مرورگر فعال نیست'}</b><span>{subscribed?'تازه‌ترین رویدادها حتی بیرون از همین صفحه به شما می‌رسد.':'هر رویداد در همین فهرست می‌آید؛ برای دریافت آن روی گوشی، اعلان را فعال کنید.'}</span>{pushNote&&<small>{pushNote}</small>}</div><button className={subscribed?'push-button off':'push-button'} onClick={()=>void (subscribed?disablePush():enablePush())}>{subscribed?<><BellOff size={14}/>خاموش کردن</>:<><Bell size={14}/>فعال کردن اعلان</>}</button></div>:<div className="push-panel muted"><div><b>اعلان مرورگر پیکربندی نشده</b><span>کلید وب‌پوش روی سرور تنظیم نشده، پس هیچ اعلانی به گوشی فرستاده نمی‌شود؛ فهرست پایین همچنان کامل است.</span></div></div>)}{showPrefs&&groups.length>0&&<div className="push-prefs">{groups.map(group=><label key={group.key} className="push-pref"><input type="checkbox" checked={group.enabled} onChange={event=>void toggleGroup(group.key,event.target.checked)}/><span>{groupLabels[group.key]??group.key}</span>{group.partiallyMuted&&<small>بخشی خاموش</small>}</label>)}</div>}{busy&&items.length===0?<SkeletonList rows={4} label="در حال دریافت اعلان‌ها…"/>:items.length===0?<div className="ops-empty"><Bell size={28}/><b>اعلان تازه‌ای ندارید</b><span>وضعیت سفارش‌هایتان که تغییر کند، اینجا خبر می‌گیری.</span><a className="checkout-action" href="/orders">پیگیری سفارش‌ها<ArrowLeft size={15}/></a></div>:<div className="notification-list">{items.map(item=><button className={`notification-item ${item.readAt?'':'unread'}`} key={item.id} onClick={()=>void openNotice(item)}><span className="notification-icon"><Bell size={16}/></span><span className="notification-content"><b>{item.title}</b><small>{item.body}</small><time>{date(item.createdAt)}</time>{item.pushState!=='NONE'&&<i className={`push-state ${label(item.pushState).className}`} title={item.pushError??undefined}>{label(item.pushState).text}</i>}</span>{!item.readAt&&<i className="unread-dot"/>}</button>)}</div>}</>}</main><footer className="admin-footer">جتینو · اعلان‌های حساب</footer></div>;
}
const groupLabels:Record<string,string>={
 ORDER_STATUS:'وضعیت سفارش',ORDER_CANCELLATION:'لغو و بازپرداخت',DELIVERY:'ارسال و پیک',FEEDBACK:'بازخورد و امتیاز',
 SUPPORT:'گزارش‌های پشتیبانی',SETTLEMENT:'تسویه وجه نقد',SHOP:'سفارش‌های تازه فروشگاه',
};
function applicationKey(key:string):Uint8Array<ArrayBuffer>{
 const padded=key.replace(/-/g,'+').replace(/_/g,'/');
 const withPadding=padded+'='.repeat((4-(padded.length%4))%4);
 const raw=atob(withPadding);
 const bytes=new Uint8Array(new ArrayBuffer(raw.length));
 for(let index=0;index<raw.length;index+=1)bytes[index]=raw.charCodeAt(index);
 return bytes;
}
