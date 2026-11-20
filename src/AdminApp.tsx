import { useEffect, useState } from 'react';
import { ArrowLeft, KeyRound, LogOut, RefreshCw, Save, Settings2, ShieldCheck, Truck } from 'lucide-react';
import AdminPartners from './AdminPartners';
import AdminDispatchPanel from './AdminDispatchPanel';
import AdminOrderMonitor from './AdminOrderMonitor';
import AdminCashSettlement from './AdminCashSettlement';
import AdminBusinessPerformance from './AdminBusinessPerformance';
import AdminAuditLog from './AdminAuditLog';
import { AdminFeedbackBoard, SupportPanel } from './FeedbackSupport';
import { CancellationBoard } from './Cancellations';
import { NotificationDeliveryBoard } from './NotificationDelivery';
import { otpRequestNotice } from './testOtpNotice';

type Settings = { region: string; regionSlug: string; deliveryFeeRial: string | null; defaultCommissionBps: number; currency: string };
type ReportSummary={totalOrders:string;ordersInPeriod:string;cancelledOrders:string;cancelledInPeriod:string;openCancellationRequests:string;refundedRialInPeriod:string;period:string;periodLabel:string;awaitingBusiness:string;inDelivery:string;deliveredOrders:string;grossOrderValueRial:string;cashCollectedRial:string;unsettledCashRial:string;unsettledCollections:string;generatedAt:string};
type ApiError = { message?: string };
const toAsciiDigits = (value: string) => value.replace(/[۰-۹]/g, digit => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit))).replace(/[٠-٩]/g, digit => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)));
const persianNumber=(value:string|number)=>new Intl.NumberFormat('fa-IR').format(Number(value));
const moneyRial=(value:string)=>new Intl.NumberFormat('fa-IR').format(BigInt(value))+' ریال';
async function api<T>(path: string, body?: unknown, token?: string): Promise<T> {
  const response = await fetch(path, { method: body === undefined ? 'GET' : 'PATCH', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json().catch(() => ({})) as T & ApiError;
  if (!response.ok) throw new Error(typeof result.message === 'string' ? result.message : `خطا در ارتباط با سرور (${response.status})`);
  return result;
}

export default function AdminApp() {
  const [phone, setPhone] = useState(''); const [code, setCode] = useState('');
  const [token, setToken] = useState(''); const [settings, setSettings] = useState<Settings|null>(null);const [reports,setReports]=useState<ReportSummary|null>(null);const [reportPeriod,setReportPeriod]=useState('24h');const [loadingReports,setLoadingReports]=useState(false);
  const [fee, setFee] = useState(''); const [commission, setCommission] = useState('');
  const [step, setStep] = useState<'phone'|'code'|'settings'>('phone');
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  useEffect(() => { document.title = 'تنظیمات مدیر کل | جتینو'; }, []);
  const requestCode = async () => {
    setBusy(true); setError(''); setNotice('');
    try { const sent = await api('/api/v1/auth/otp/request', { phone }); setStep('code'); setNotice(otpRequestNotice(sent, 'اگر شماره معتبر باشد، کد ورود پیامک می‌شود.')); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const verify = async () => {
    setBusy(true); setError('');
    try {
      const result = await api<{accessToken:string;user:{roles:string[]}}>('/api/v1/auth/otp/verify', { phone, code });
      if (!result.user.roles.includes('SUPER_ADMIN')) throw new Error('این حساب دسترسی مدیر کل ندارد.');
      setToken(result.accessToken);
      const [current,summary] = await Promise.all([api<Settings>('/api/v1/admin/settings', undefined, result.accessToken),api<ReportSummary>('/api/v1/admin/reports/summary',undefined,result.accessToken)]);
      setSettings(current);setReports(summary);setFee(current.deliveryFeeRial ?? ''); setCommission(String(current.defaultCommissionBps / 100)); setStep('settings');
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
  const loadReports = async (period=reportPeriod) => {
    setLoadingReports(true);setError('');
    try { setReports(await api<ReportSummary>(`/api/v1/admin/reports/summary?period=${encodeURIComponent(period)}`,undefined,token)); }
    catch(e) { setError((e as Error).message); } finally { setLoadingReports(false); }
  };
  const logout = () => { setToken(''); setSettings(null); setReports(null); setCode(''); setStep('phone'); setError(''); setNotice(''); };
  return <div className="admin-page" dir="rtl"><header className="admin-header"><a href="/" className="brand"><span className="brand-mark">ج</span><span>جتینو<small>مدیریت پلتفرم</small></span></a><a className="back-link" href="/"><ArrowLeft size={15}/>بازگشت به فروشگاه</a></header>
    <main className="admin-main"><div className="admin-intro"><span className="admin-symbol"><Settings2 size={22}/></span><div><div className="eyebrow muted">پنل عملیاتی</div><h1>تنظیمات مالی</h1><p>مبالغ پایهٔ سفارش و کمیسیون پیش‌فرض پلتفرم را مدیریت کنید.</p></div></div>
      {step!=='settings'?<section className="admin-card auth-card"><div className="card-icon"><ShieldCheck size={20}/></div><h2>{step==='phone'?'ورود مدیر کل':'تأیید شمارهٔ موبایل'}</h2><p>ورود امن با کد یک‌بارمصرف پیامکی کاوه‌نگار</p>
        {step==='phone'?<><label className="field-label" htmlFor="admin-phone">شماره موبایل</label><input id="admin-phone" className="admin-input" value={phone} onChange={e=>setPhone(toAsciiDigits(e.target.value))} placeholder="۰۹۱۲۳۴۵۶۷۸۹" autoComplete="tel"/><button className="primary-button" disabled={busy||!phone.trim()} onClick={requestCode}>{busy?'در حال ارسال…':'دریافت کد ورود'}<ArrowLeft size={16}/></button></>:<><label className="field-label" htmlFor="admin-code">کد پیامک‌شده</label><input id="admin-code" className="admin-input code-input" value={code} onChange={e=>setCode(toAsciiDigits(e.target.value).replace(/\D/g,'').slice(0,6))} inputMode="numeric" autoComplete="one-time-code" placeholder="کد ۶ رقمی"/><button className="primary-button" disabled={busy||code.length!==6} onClick={verify}>{busy?'در حال بررسی…':'ورود به پنل'}<KeyRound size={16}/></button><button className="text-button" onClick={()=>{setStep('phone');setCode('');setError('');}}>ویرایش شماره یا ارسال دوباره</button></>}
      </section>:<><section className="admin-card report-card"><div className="report-heading"><div><h2>نمای کلی عملیات</h2><small>سفارش‌های کل پلتفرم · به‌روزرسانی {reports?new Intl.DateTimeFormat('fa-IR',{timeStyle:'short'}).format(new Date(reports.generatedAt)):'—'}</small></div><div className="report-controls"><select aria-label="بازهٔ گزارش سفارش‌ها" value={reportPeriod} disabled={loadingReports} onChange={e=>{setReportPeriod(e.target.value);void loadReports(e.target.value);}}><option value="24h">۲۴ ساعت</option><option value="7d">۷ روز</option><option value="30d">۳۰ روز</option></select><button className="refresh-button" disabled={loadingReports} onClick={()=>void loadReports()}><RefreshCw size={14}/>{loadingReports?'در حال دریافت…':'به‌روزرسانی'}</button></div></div>{reports&&<div className="report-grid"><div><small>سفارش در {reports.periodLabel}</small><b>{persianNumber(reports.ordersInPeriod)}</b></div><div><small>در انتظار کسب‌وکار</small><b>{persianNumber(reports.awaitingBusiness)}</b></div><div><small>در جریان ارسال</small><b>{persianNumber(reports.inDelivery)}</b></div><div><small>تحویل‌شده</small><b>{persianNumber(reports.deliveredOrders)}</b></div><div><small>ارزش کل سفارش‌ها</small><b>{moneyRial(reports.grossOrderValueRial)}</b></div><div><small>وجه نقد وصول‌شده</small><b>{moneyRial(reports.cashCollectedRial)}</b></div><div><small>لغو در {reports.periodLabel}</small><b>{new Intl.NumberFormat('fa-IR').format(Number(reports.cancelledInPeriod))}</b><i>{new Intl.NumberFormat('fa-IR').format(Number(reports.cancelledOrders))} لغو در کل · {new Intl.NumberFormat('fa-IR').format(Number(reports.openCancellationRequests))} درخواست باز</i></div><div><small>بازپرداخت در {reports.periodLabel}</small><b>{moneyRial(reports.refundedRialInPeriod)}</b></div><div><small>در انتظار تسویه راننده</small><b>{moneyRial(reports.unsettledCashRial)}</b><i>{persianNumber(reports.unsettledCollections)} وصول ثبت‌شده</i></div></div>}</section><AdminOrderMonitor token={token}/><AdminBusinessPerformance token={token}/><AdminCashSettlement token={token} onSettled={()=>void loadReports()}/><section className="admin-card settings-card"><div className="settings-title"><div><span className="live-tag"><i/>فعال</span><h2>مقادیر پیش‌فرض</h2><p>منطقهٔ {settings?.region} · قابل ویرایش در هر زمان</p></div><button className="logout-button" onClick={logout}><LogOut size={15}/>خروج</button></div><div className="setting-row"><span className="setting-icon"><Truck size={18}/></span><div className="setting-copy"><b>کرایهٔ ثابت ارسال</b><small>برای هر سفارش · به ریال</small></div><label className="money-input"><input aria-label="کرایهٔ ارسال به ریال" value={fee} onChange={e=>setFee(toAsciiDigits(e.target.value).replace(/\D/g,''))} inputMode="numeric"/><span>ریال</span></label></div><div className="setting-row"><span className="setting-icon commission-icon">٪</span><div className="setting-copy"><b>کمیسیون پیش‌فرض</b><small>در صورت نداشتن نرخ اختصاصی کسب‌وکار</small></div><label className="money-input percent-input"><input aria-label="درصد کمیسیون" value={commission} onChange={e=>setCommission(toAsciiDigits(e.target.value).replace(/[^\d.]/g,''))} inputMode="decimal"/><span>٪</span></label></div><div className="snapshot-note"><ShieldCheck size={16}/><span>نرخ کمیسیون و هزینهٔ ارسال زمان ثبت سفارش ذخیره می‌شوند؛ تغییرات جدید روی سفارش‌های قبلی اعمال نمی‌شوند.</span></div><button className="primary-button save-button" disabled={busy} onClick={save}><Save size={17}/>{busy?'در حال ذخیره…':'ذخیرهٔ تنظیمات'}</button></section><div className="settings-meta">آخرین مقادیر بارگذاری‌شده · کمیسیون فعلی {settings?.defaultCommissionBps ? `${settings.defaultCommissionBps/100}٪` : '۰٪'}</div><AdminPartners token={token}/><AdminDispatchPanel token={token}/><SupportPanel token={token} staff/><AdminFeedbackBoard token={token}/><CancellationBoard token={token}/><NotificationDeliveryBoard token={token}/><AdminAuditLog token={token}/></>}
      {error&&<div className="feedback error" role="alert">{error}</div>}{notice&&<div className="feedback success" role="status">{notice}</div>}
      <div className="admin-footnote"><ShieldCheck size={15}/>این بخش فقط برای مدیر کل جتینو قابل دسترسی است.</div>
    </main><footer className="admin-footer">جتینو · پنل مدیر کل</footer></div>;
}
