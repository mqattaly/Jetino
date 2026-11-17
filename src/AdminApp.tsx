import { useEffect, useState } from 'react';
import { ArrowLeft, Check, KeyRound, LogOut, RefreshCw, Save, Settings2, ShieldCheck, Store, Truck, X } from 'lucide-react';

type Settings = { region: string; regionSlug: string; deliveryFeeRial: string | null; defaultCommissionBps: number; currency: string };
type BusinessRequest = { id:string; name:string; description:string|null; status:string; createdAt:string; regionName:string; ownerPhone:string };
type ApiError = { message?: string };
const toAsciiDigits = (value: string) => value.replace(/[۰-۹]/g, digit => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit))).replace(/[٠-٩]/g, digit => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)));
async function api<T>(path: string, body?: unknown, token?: string): Promise<T> {
  const response = await fetch(path, { method: body === undefined ? 'GET' : 'PATCH', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json().catch(() => ({})) as T & ApiError;
  if (!response.ok) throw new Error(typeof result.message === 'string' ? result.message : `خطا در ارتباط با سرور (${response.status})`);
  return result;
}

export default function AdminApp() {
  const [phone, setPhone] = useState(''); const [code, setCode] = useState('');
  const [token, setToken] = useState(''); const [settings, setSettings] = useState<Settings|null>(null);
  const [fee, setFee] = useState(''); const [commission, setCommission] = useState('');
  const [businesses, setBusinesses] = useState<BusinessRequest[]>([]); const [loadingBusinesses, setLoadingBusinesses] = useState(false);
  const [step, setStep] = useState<'phone'|'code'|'settings'>('phone');
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  useEffect(() => { document.title = 'تنظیمات مدیر کل | جتینو'; }, []);
  const requestCode = async () => {
    setBusy(true); setError(''); setNotice('');
    try { await api('/api/v1/auth/otp/request', { phone }); setStep('code'); setNotice('اگر شماره معتبر باشد، کد ورود پیامک می‌شود.'); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const verify = async () => {
    setBusy(true); setError('');
    try {
      const result = await api<{accessToken:string;user:{roles:string[]}}>('/api/v1/auth/otp/verify', { phone, code });
      if (!result.user.roles.includes('SUPER_ADMIN')) throw new Error('این حساب دسترسی مدیر کل ندارد.');
      setToken(result.accessToken);
      const current = await api<Settings>('/api/v1/admin/settings', undefined, result.accessToken);
      setSettings(current); setFee(current.deliveryFeeRial ?? ''); setCommission(String(current.defaultCommissionBps / 100)); setStep('settings');
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const save = async () => {
    const parsedFee = Number(fee); const parsedCommission = Number(commission);
    if (!Number.isSafeInteger(parsedFee) || parsedFee < 0) { setError('کرایهٔ ارسال را به ریال و به‌صورت عدد صحیح وارد کنید.'); return; }
    if (!Number.isFinite(parsedCommission) || parsedCommission < 0 || parsedCommission > 100 || !Number.isInteger(parsedCommission * 100)) { setError('کمیسیون باید بین ۰ تا ۱۰۰ درصد و حداکثر با دو رقم اعشار باشد.'); return; }
    setBusy(true); setError(''); setNotice('');
    try {
      const updated = await api<Settings>('/api/v1/admin/settings', { deliveryFeeRial: parsedFee, defaultCommissionBps: Math.round(parsedCommission * 100) }, token);
      setSettings(updated); setNotice('تنظیمات با موفقیت ذخیره شد. تغییرات در سابقهٔ ممیزی ثبت شدند.');
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const loadBusinesses = async () => {
    setLoadingBusinesses(true); setError('');
    try { setBusinesses(await api<BusinessRequest[]>('/api/v1/admin/businesses?status=PENDING', undefined, token)); }
    catch (e) { setError((e as Error).message); } finally { setLoadingBusinesses(false); }
  };
  const setBusinessStatus = async (id:string, status:'ACTIVE'|'REJECTED') => {
    setBusy(true); setError(''); setNotice('');
    try {
      await api(`/api/v1/admin/businesses/${id}/status`, { status }, token);
      setBusinesses(items => items.filter(item => item.id !== id));
      setNotice(status === 'ACTIVE' ? 'کسب‌وکار تأیید و فعال شد.' : 'درخواست کسب‌وکار رد شد.');
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const logout = () => { setToken(''); setSettings(null); setBusinesses([]); setCode(''); setStep('phone'); setError(''); setNotice(''); };
  return <div className="admin-page" dir="rtl"><header className="admin-header"><a href="/" className="brand"><span className="brand-mark">ج</span><span>جتینو<small>مدیریت پلتفرم</small></span></a><a className="back-link" href="/"><ArrowLeft size={15}/>بازگشت به فروشگاه</a></header>
    <main className="admin-main"><div className="admin-intro"><span className="admin-symbol"><Settings2 size={22}/></span><div><div className="eyebrow muted">پنل عملیاتی</div><h1>تنظیمات مالی</h1><p>مبالغ پایهٔ سفارش و کمیسیون پیش‌فرض پلتفرم را مدیریت کنید.</p></div></div>
      {step!=='settings'?<section className="admin-card auth-card"><div className="card-icon"><ShieldCheck size={20}/></div><h2>{step==='phone'?'ورود مدیر کل':'تأیید شمارهٔ موبایل'}</h2><p>ورود امن با کد یک‌بارمصرف پیامکی کاوه‌نگار</p>
        {step==='phone'?<><label className="field-label" htmlFor="admin-phone">شماره موبایل</label><input id="admin-phone" className="admin-input" value={phone} onChange={e=>setPhone(toAsciiDigits(e.target.value))} placeholder="۰۹۱۲۳۴۵۶۷۸۹" autoComplete="tel"/><button className="primary-button" disabled={busy||!phone.trim()} onClick={requestCode}>{busy?'در حال ارسال…':'دریافت کد ورود'}<ArrowLeft size={16}/></button></>:<><label className="field-label" htmlFor="admin-code">کد پیامک‌شده</label><input id="admin-code" className="admin-input code-input" value={code} onChange={e=>setCode(toAsciiDigits(e.target.value).replace(/\D/g,'').slice(0,6))} inputMode="numeric" autoComplete="one-time-code" placeholder="کد ۶ رقمی"/><button className="primary-button" disabled={busy||code.length!==6} onClick={verify}>{busy?'در حال بررسی…':'ورود به پنل'}<KeyRound size={16}/></button><button className="text-button" onClick={()=>{setStep('phone');setCode('');setError('');}}>ویرایش شماره یا ارسال دوباره</button></>}
      </section>:<><section className="admin-card settings-card"><div className="settings-title"><div><span className="live-tag"><i/>فعال</span><h2>مقادیر پیش‌فرض</h2><p>منطقهٔ {settings?.region} · قابل ویرایش در هر زمان</p></div><button className="logout-button" onClick={logout}><LogOut size={15}/>خروج</button></div><div className="setting-row"><span className="setting-icon"><Truck size={18}/></span><div className="setting-copy"><b>کرایهٔ ثابت ارسال</b><small>برای هر سفارش · به ریال</small></div><label className="money-input"><input aria-label="کرایهٔ ارسال به ریال" value={fee} onChange={e=>setFee(toAsciiDigits(e.target.value).replace(/\D/g,''))} inputMode="numeric"/><span>ریال</span></label></div><div className="setting-row"><span className="setting-icon commission-icon">٪</span><div className="setting-copy"><b>کمیسیون پیش‌فرض</b><small>در صورت نداشتن نرخ اختصاصی کسب‌وکار</small></div><label className="money-input percent-input"><input aria-label="درصد کمیسیون" value={commission} onChange={e=>setCommission(toAsciiDigits(e.target.value).replace(/[^\d.]/g,''))} inputMode="decimal"/><span>٪</span></label></div><div className="snapshot-note"><ShieldCheck size={16}/><span>نرخ کمیسیون و هزینهٔ ارسال زمان ثبت سفارش ذخیره می‌شوند؛ تغییرات جدید روی سفارش‌های قبلی اعمال نمی‌شوند.</span></div><button className="primary-button save-button" disabled={busy} onClick={save}><Save size={17}/>{busy?'در حال ذخیره…':'ذخیرهٔ تنظیمات'}</button></section><div className="settings-meta">آخرین مقادیر بارگذاری‌شده · کمیسیون فعلی {settings?.defaultCommissionBps ? `${settings.defaultCommissionBps/100}٪` : '۰٪'}</div><section className="admin-card business-queue"><div className="queue-heading"><div><span className="setting-icon"><Store size={18}/></span><div><h2>درخواست‌های کسب‌وکار</h2><small>بررسی و فعال‌سازی کسب‌وکارهای ثبت‌شده</small></div></div><button className="refresh-button" disabled={loadingBusinesses} onClick={loadBusinesses}><RefreshCw size={14}/>{loadingBusinesses?'در حال دریافت…':'بارگذاری درخواست‌ها'}</button></div>{businesses.length===0?<div className="queue-empty">برای نمایش درخواست‌های در انتظار، روی «بارگذاری درخواست‌ها» بزنید.</div>:businesses.map(item=><div className="business-request" key={item.id}><div className="request-details"><b>{item.name}</b><span>{item.regionName} · {item.ownerPhone}</span>{item.description&&<small>{item.description}</small>}</div><div className="request-actions"><button disabled={busy} className="approve-button" onClick={()=>setBusinessStatus(item.id,'ACTIVE')}><Check size={14}/>تأیید</button><button disabled={busy} className="reject-button" onClick={()=>setBusinessStatus(item.id,'REJECTED')}><X size={14}/>رد</button></div></div>)}</section></>}
      {error&&<div className="feedback error" role="alert">{error}</div>}{notice&&<div className="feedback success" role="status">{notice}</div>}
      <div className="admin-footnote"><ShieldCheck size={15}/>این بخش فقط برای مدیر کل جتینو قابل دسترسی است.</div>
    </main><footer className="admin-footer">جتینو · پنل مدیر کل</footer></div>;
}
