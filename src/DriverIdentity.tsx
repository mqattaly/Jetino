import { useCallback, useEffect, useRef, useState } from 'react';
import { LiquidLoader } from './ui/motion';
import { BadgeCheck, Camera, CheckCircle2, Clock3, FileSignature, RefreshCw, ShieldAlert, ShieldCheck, Video } from 'lucide-react';

type Identity = {
  configured: boolean;
  biometricConfigured: boolean;
  requireIdentity: boolean;
  nationalCode: string | null;
  birthDate: string | null;
  cardSerial: string | null;
  gender: number | null;
  shahkarMatched: boolean | null;
  identityMatched: boolean | null;
  identityReady: boolean;
  firstName: string | null;
  lastName: string | null;
  fatherName: string | null;
  identityCheckedAt: string | null;
  biometricStatus: 'NONE' | 'PENDING' | 'MATCHED' | 'REJECTED' | 'FAILED';
  biometricReason: string | null;
  biometricReasonText: string | null;
  biometricCheckedAt: string | null;
  hasSession: boolean;
  complete: boolean;
};

type ApiError = { message?: string };
const MAX_VIDEO = 4_000_000;
const fa = (value: string | number) => new Intl.NumberFormat('fa-IR').format(Number(value));
const ascii = (value: string) => value.replace(/[۰-۹]/g, d => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d))).replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
const clock = (value: string | null) => value ? new Intl.DateTimeFormat('fa-IR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value)) : '—';

async function json<T>(path: string, token: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), Authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json().catch(() => ({})) as T & ApiError;
  if (!response.ok) throw new Error(typeof data.message === 'string' ? data.message : `خطا (${response.status})`);
  return data;
}

const BIOMETRIC_COPY: Record<string, { label: string; tone: string }> = {
  NONE: { label: 'ویدئو نفرستادی', tone: 'pending' },
  PENDING: { label: 'ویدئو در حال بررسی', tone: 'pending' },
  MATCHED: { label: 'چهره تأیید شد', tone: 'ok' },
  REJECTED: { label: 'ویدئو تأیید نشد', tone: 'bad' },
  FAILED: { label: 'ارسال ویدئو مشکل داشت', tone: 'bad' },
};

/**
 * The courier's official identity: the phone must belong to the national code (Shahkar), the
 * national registry must know that birthday, and a fresh selfie video must match the face.
 * The phone camera is opened with `capture`, so the video is recorded now — not picked from a gallery.
 */
export function DriverIdentity({ token }: { token: string }) {
  const [data, setData] = useState<Identity | null>(null);
  const [form, setForm] = useState({ nationalCode: '', birthDate: '', cardSerial: '', gender: '1' });
  const [editing, setEditing] = useState(false);
  const [video, setVideo] = useState<File | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const preview = video ? URL.createObjectURL(video) : null;

  const load = useCallback(async () => {
    try {
      const next = await json<Identity>('/api/v1/drivers/me/identity', token);
      setData(next);
      setForm(current => current.nationalCode || !next.birthDate ? current : { ...current, birthDate: next.birthDate ?? '' });
    } catch (e) { setError((e as Error).message); }
  }, [token]);
  useEffect(() => { void load(); }, [load]);

  // A pending video is the only thing worth polling, and only while the courier is on this screen.
  useEffect(() => {
    if (data?.biometricStatus !== 'PENDING') return;
    const timer = window.setInterval(() => {
      void json<Identity>('/api/v1/drivers/me/identity/biometric', token).then(setData).catch(() => undefined);
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [data?.biometricStatus, token]);

  const verify = async () => {
    setBusy('verify'); setError(''); setNotice('');
    try {
      const next = await json<Identity>('/api/v1/drivers/me/identity/verify', token, 'POST', {
        nationalCode: ascii(form.nationalCode), birthDate: ascii(form.birthDate),
        cardSerial: ascii(form.cardSerial), gender: form.gender,
      });
      setData(next); setEditing(false);
      setNotice('هویتت تأیید شد؛ شمارهٔ موبایل و کد ملی یکی بودن و ثبت احوال هم همین نام رو داد.');
    } catch (e) { setError((e as Error).message); await load(); }
    finally { setBusy(''); }
  };

  const sendVideo = async () => {
    if (!video) { setError('اول ویدئوی سلفی رو ضبط کن.'); return; }
    if (video.size > MAX_VIDEO) { setError('ویدئو بزرگ‌تر از ۴ مگابایته؛ کوتاه‌تر (۱۰ ثانیه) ضبط کن.'); return; }
    const type = video.type || (video.name.toLowerCase().endsWith('.mp4') ? 'video/mp4' : 'video/webm');
    if (!['video/webm', 'video/mp4', 'video/quicktime'].includes(type)) { setError('فقط ویدئوی webm یا mp4 قبول می‌شه.'); return; }
    setBusy('video'); setError(''); setNotice('');
    try {
      const response = await fetch('/api/v1/drivers/me/identity/biometric', {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': type }, body: video,
      });
      const next = await response.json().catch(() => ({})) as Identity & ApiError;
      if (!response.ok) throw new Error(next.message || `خطا (${response.status})`);
      setData(next); setVideo(null);
      setNotice('ویدئو رفت برای بررسی؛ نتیجه معمولاً چند دقیقه‌ای مشخص می‌شه و همون‌جا می‌بینی‌اش.');
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(''); }
  };

  const copy = BIOMETRIC_COPY[data?.biometricStatus ?? 'NONE'];
  const stepOneDone = data?.identityReady === true;
  const canEditForm = data && (!stepOneDone || editing);

  return <section className="admin-card identity-card">
    <div className="driver-profile-head">
      <div>
        <h2><ShieldCheck size={18} /> احراز هویت رسمی</h2>
        <p>سه چیز با هم چک می‌شه: موبایلی که با آن وارد می‌شی به نام همین کد ملی باشد، ثبت احوال همین تاریخ تولد را بشناسد، و ویدئوی سلفی چهرهٔ خودت باشد.</p>
      </div>
      {data && <span className={`status-pill ${data.complete ? 'verified-pill' : 'pending-pill'}`}>
        {data.complete ? <BadgeCheck size={14} /> : <Clock3 size={14} />}{data.complete ? 'کامل' : 'در جریان'}
      </span>}
    </div>

    {error && <div className="feedback error" role="alert">{error}</div>}
    {notice && <div className="feedback success" role="status">{notice}</div>}

    {!data && !error && <LiquidLoader label="دارم وضعیت احراز هویتت رو می‌گیرم…" />}

    {data && !data.configured && <p className="verification-hint"><ShieldAlert size={14} />این بخش تازه راه افتاده و کلید سرویس استعلامش هنوز وصل نشده؛ به‌زودی فعال می‌شه. تا آن موقع تأیید مدارک مثل قبل با بررسی کارشناس انجام می‌شه.</p>}

    {data?.configured && <>
      <ol className="identity-steps">
        <li className={stepOneDone ? 'done' : ''}>
          <span className="identity-step-num">{stepOneDone ? <CheckCircle2 size={14} /> : '۱'}</span>
          <div><b>کد ملی و شمارهٔ موبایل</b><small>{stepOneDone ? 'تأیید شد' : 'شاهکار + ثبت احوال'}</small></div>
        </li>
        <li className={data.biometricStatus === 'MATCHED' ? 'done' : ''}>
          <span className="identity-step-num">{data.biometricStatus === 'MATCHED' ? <CheckCircle2 size={14} /> : '۲'}</span>
          <div><b>ویدئوی سلفی</b><small>{copy.label}</small></div>
        </li>
      </ol>

      {stepOneDone && !editing ? <div className="identity-result">
        <div className="identity-result-head"><FileSignature size={16} /><b>{[data.firstName, data.lastName].filter(Boolean).join(' ') || 'هویت تأییدشده'}</b>
          <span className="status-pill verified-pill"><BadgeCheck size={13} />ثبت احوال</span></div>
        <dl className="identity-facts">
          <div><dt>کد ملی</dt><dd dir="ltr">{data.nationalCode}</dd></div>
          <div><dt>تاریخ تولد</dt><dd>{data.birthDate}</dd></div>
          <div><dt>سریال کارت</dt><dd dir="ltr">{data.cardSerial}</dd></div>
          <div><dt>آخرین استعلام</dt><dd>{clock(data.identityCheckedAt)}</dd></div>
        </dl>
        <button type="button" className="text-button" disabled={Boolean(busy)} onClick={() => setEditing(true)}><RefreshCw size={14} />استعلام دوباره</button>
      </div> : null}

      {canEditForm && <div className="identity-form">
        <div className="identity-grid">
          <label className="checkout-label">کد ملی<input className="checkout-input" dir="ltr" inputMode="numeric" maxLength={10} value={form.nationalCode}
            placeholder="0012345679" onChange={e => setForm({ ...form, nationalCode: ascii(e.target.value).replace(/\D/g, '').slice(0, 10) })} /></label>
          <label className="checkout-label">تاریخ تولد (شمسی)<input className="checkout-input" dir="ltr" inputMode="numeric" maxLength={10} value={form.birthDate}
            placeholder="1377/06/30" onChange={e => setForm({ ...form, birthDate: ascii(e.target.value).replace(/[^\d/-]/g, '').slice(0, 10) })} /></label>
          <label className="checkout-label">سریال کارت ملی<input className="checkout-input" dir="ltr" inputMode="numeric" maxLength={10} value={form.cardSerial}
            placeholder="۱۰ رقم پشت کارت" onChange={e => setForm({ ...form, cardSerial: ascii(e.target.value).replace(/\D/g, '').slice(0, 10) })} /></label>
          <label className="checkout-label">جنسیت<select className="checkout-input" value={form.gender} onChange={e => setForm({ ...form, gender: e.target.value })}>
            <option value="1">مرد</option><option value="0">زن</option>
          </select></label>
        </div>
        <p className="verification-hint">شمارهٔ موبایل همان شماره‌ای است که با آن وارد شدی؛ اگر به نام خودت نیست، اول با شمارهٔ خودت وارد شو.</p>
        <div className="identity-actions">
          <button type="button" className="primary-button" disabled={busy === 'verify' || form.nationalCode.length !== 10 || form.birthDate.length < 8 || form.cardSerial.length !== 10} onClick={() => void verify()}>
            <ShieldCheck size={16} />{busy === 'verify' ? 'دارم استعلام می‌گیرم…' : 'استعلام هویت'}
          </button>
          {editing && <button type="button" className="text-button" onClick={() => setEditing(false)}>بی‌خیال</button>}
        </div>
      </div>}

      {stepOneDone && <div className="identity-video">
        <div className="identity-video-head"><Video size={16} /><b>ویدئوی سلفی</b>
          <span className={`status-pill ${copy.tone === 'ok' ? 'verified-pill' : copy.tone === 'bad' ? 'rejected-pill' : 'pending-pill'}`}>{copy.label}</span></div>
        {data.biometricStatus === 'REJECTED' && data.biometricReasonText && <p className="verification-warning"><ShieldAlert size={14} />{data.biometricReasonText}</p>}
        {data.biometricStatus === 'PENDING' && <p className="verification-hint"><Clock3 size={14} />ویدئوت در حال بررسیه؛ همون‌جا می‌مونی، هر ۱۵ ثانیه یه بار چک می‌کنم{data.hasSession ? '' : ' — اگه طولانی شد با پشتیبانی تماس بگیر'}.</p>}
        {data.biometricStatus === 'MATCHED'
          ? <p className="verification-hint"><BadgeCheck size={14} />چهره‌ات تأیید شد{data.biometricCheckedAt ? ` · ${clock(data.biometricCheckedAt)}` : ''}. برای ضبط دوباره، ویدئوی تازه بفرست.</p>
          : <p className="verification-hint">حدود ۱۰ ثانیه، رو به نور، بدون ماسک و عینک، صورتت کامل تو کادر. ویدئو باید همین حالا ضبط بشه.</p>}
        <input ref={fileRef} className="photo-field-input" type="file" accept="video/webm,video/mp4,video/*" capture="user" aria-label="ویدئوی سلفی"
          onChange={e => { const file = e.target.files?.[0] ?? null; setError(''); setVideo(file); }} />
        {preview && <video className="identity-preview" src={preview} controls playsInline muted />}
        {video && <small className="verification-hint">حجم ویدئو: {fa((video.size / 1_000_000).toFixed(1))} مگابایت {video.size > MAX_VIDEO ? '— بزرگ‌تر از حد مجازه، کوتاه‌تر ضبط کن.' : ''}</small>}
        <div className="identity-actions">
          <button type="button" className="menu-edit" disabled={Boolean(busy)} onClick={() => fileRef.current?.click()}><Camera size={15} />{video ? 'ضبط دوباره' : 'ضبط ویدئوی سلفی'}</button>
          <button type="button" className="primary-button" disabled={Boolean(busy) || !video || video.size > MAX_VIDEO} onClick={() => void sendVideo()}>
            <Video size={16} />{busy === 'video' ? 'دارم می‌فرستم…' : 'ارسال برای بررسی'}
          </button>
        </div>
      </div>}

      {data.requireIdentity && !data.complete && <p className="verification-warning"><ShieldAlert size={14} />جتینو فعلاً مأموریت‌ها را فقط به پیک‌هایی می‌دهد که احراز هویتشان کامل باشد؛ تا اینجا را تموم کن.</p>}
    </>}
  </section>;
}
