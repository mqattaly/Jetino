import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, BadgeCheck, Bike, Clock3, ExternalLink, ImageUp, Navigation, Radio, ShieldAlert, ShieldCheck, ShieldX, Siren, UserCheck } from 'lucide-react';
import { PhotoField } from './PhotoField';

type ApiError = { message?: string };
const fa = (value: number) => new Intl.NumberFormat('fa-IR').format(value);
const clock = (value: string | null) => value ? new Intl.DateTimeFormat('fa-IR', { timeStyle: 'short' }).format(new Date(value)) : '—';

async function api<T>(path: string, token: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), Authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json().catch(() => ({})) as T & ApiError;
  if (!response.ok) throw new Error(typeof data.message === 'string' ? data.message : `خطا (${response.status})`);
  return data;
}

type Tracking = {
  orderId: string; status: string; live: boolean; stale: boolean; message: string; lastSeenAt: string | null;
  etaMinutes: number | null; distanceMeters: number | null;
  location: { latitude: number; longitude: number; accuracyMeters: number | null; updatedAt: string } | null;
  destination: { latitude: number; longitude: number } | null;
  driver: { id: string; name: string | null; photoUrl: string | null; plateNumber: string | null; vehicleType: string | null; verificationStatus: string; verified: boolean } | null;
};

const vehicleLabel: Record<string, string> = { MOTORCYCLE: 'موتورسیکلت', CAR: 'خودرو', BICYCLE: 'دوچرخه', OTHER: 'وسیلهٔ دیگر' };
const mapLink = (latitude: number, longitude: number) => `https://neshan.org/maps/@${latitude.toFixed(5)},${longitude.toFixed(5)},16z`;

/**
 * The live pin. It polls only while a delivery is actually running, stops on its own when
 * the order closes, and never invents a position: an old fix is labelled as "last seen".
 */
export function LiveTracking({ token, orderId, active, compact = false }: { token: string; orderId: string; active: boolean; compact?: boolean }) {
  const [data, setData] = useState<Tracking | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!active) { setData(null); return; }
    let alive = true;
    const load = async () => {
      try {
        const next = await api<Tracking>(`/api/v1/delivery/orders/${orderId}/tracking`, token);
        if (alive) { setData(next); setFailed(false); }
      } catch { if (alive) setFailed(true); }
    };
    void load();
    const timer = window.setInterval(() => { if (!document.hidden) void load(); }, 15000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [token, orderId, active]);

  if (!active) return null;
  const driver = data?.driver;
  return <section className={`live-tracking${compact ? ' compact' : ''}`} aria-live="polite">
    <div className="live-tracking-head">
      <span className="live-tracking-title"><Radio size={16} className={data?.live ? 'live-dot' : ''} />موقعیت پیک</span>
      {data?.live ? <span className="status-pill verified-pill"><i className="live-dot" />زنده</span>
        : data?.stale ? <span className="status-pill pending-pill">آخرین موقعیت</span>
          : driver ? <span className="status-pill">در انتظار موقعیت</span> : null}
    </div>
    {failed && <p className="live-tracking-note">دریافت موقعیت ممکن نشد؛ صفحه را دوباره به‌روزرسانی کنید.</p>}
    {!failed && data && <>
      {driver ? <div className="driver-badge compact">
        {driver.photoUrl ? <img className="driver-avatar" src={driver.photoUrl} alt={driver.name ? `تصویر ${driver.name}` : 'تصویر پیک'} loading="lazy" />
          : <span className="driver-avatar empty" aria-hidden="true"><Bike size={20} /></span>}
        <div>
          <b>{driver.name || 'پیک جتینو'} {driver.verified && <BadgeCheck size={14} className="verified-icon" aria-label="مدارک تأییدشده" />}</b>
          <small>{vehicleLabel[driver.vehicleType ?? ''] ?? 'وسیلهٔ نامشخص'}{driver.plateNumber ? <> · پلاک <span className="plate-number" dir="ltr">{driver.plateNumber}</span></> : null}</small>
        </div>
      </div> : null}
      {data.location ? <div className="live-tracking-body">
        <div className="live-tracking-stats">
          {data.distanceMeters !== null && <div><small>تا نشانی شما</small><b>{data.distanceMeters < 1000 ? `${fa(data.distanceMeters)} متر` : `${fa(Math.round(data.distanceMeters / 100) / 10)} کیلومتر`}</b></div>}
          {data.etaMinutes !== null && <div><small>زمان تقریبی</small><b>{fa(data.etaMinutes)} دقیقه</b></div>}
          <div><small>آخرین به‌روزرسانی</small><b>{clock(data.location.updatedAt)}</b></div>
        </div>
        <a className="map-link" href={mapLink(data.location.latitude, data.location.longitude)} target="_blank" rel="noreferrer">
          <Navigation size={14} />مسیر روی نقشه<ExternalLink size={12} />
        </a>
      </div> : <p className="live-tracking-note">{data.message}{data.lastSeenAt ? ` (آخرین موقعیت: ${clock(data.lastSeenAt)})` : ''}</p>}
      {data.distanceMeters !== null && <p className="live-tracking-foot">مسافت و زمان تقریبی است و با حرکت پیک به‌روز می‌شود.</p>}
    </>}
  </section>;
}

const categories: Array<[string, string]> = [['UNSAFE', 'احساس ناامنی'], ['HARASSMENT', 'مزاحمت یا تهدید'], ['ACCIDENT', 'حادثه یا آسیب'], ['OTHER', 'موضوع دیگر']];

/** One button, one queue entry, one human on the other side. No chat, no automation. */
export function SafetyPanel({ token, orderId, role }: { token: string; orderId: string; role: 'CUSTOMER' | 'BUSINESS' | 'DRIVER' }) {
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState('UNSAFE');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState<{ reference: string; message: string } | null>(null);

  const send = async () => {
    setBusy(true); setError('');
    try {
      const result = await api<{ reference: string; message: string }>('/api/v1/safety/sos', token, 'POST', { orderId, category, note: note.trim() || undefined });
      setSent({ reference: result.reference, message: result.message });
      setNote('');
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  if (sent) return <section className="safety-panel sent" role="status">
    <ShieldCheck size={18} />
    <div><b>گزارش شما ثبت شد · کد {sent.reference}</b><small>{sent.message}</small></div>
  </section>;

  return <section className="safety-panel">
    {!open ? <button type="button" className="sos-button" onClick={() => setOpen(true)}>
      <Siren size={16} />درخواست کمک فوری
    </button> : <>
      <div className="safety-form-head"><ShieldAlert size={16} /><b>چه اتفاقی افتاده؟</b><button type="button" className="text-button" onClick={() => setOpen(false)}>بستن</button></div>
      <div className="safety-categories" role="radiogroup" aria-label="نوع مشکل">
        {categories.map(([value, label]) => <button type="button" key={value} role="radio" aria-checked={category === value} className={`safety-category${category === value ? ' selected' : ''}`} onClick={() => setCategory(value)}>{label}</button>)}
      </div>
      <label className="checkout-label">توضیح کوتاه (اختیاری)
        <input className="checkout-input" maxLength={500} value={note} onChange={e => setNote(e.target.value)} placeholder={role === 'DRIVER' ? 'مثلاً مشتری مدارک تحویل را ارائه نکرد' : 'مثلاً پیک رفتار نامناسب داشت'} />
      </label>
      {error && <p className="photo-field-error" role="alert">{error}</p>}
      <div className="safety-actions">
        <button type="button" className="sos-button" disabled={busy} onClick={() => void send()}>{busy ? 'در حال ثبت…' : 'ثبت گزارش برای پشتیبانی'}</button>
        <small>پشتیبانی جتینو بلافاصله مطلع می‌شود. در خطر جانی با ۱۱۰ تماس بگیرید.</small>
      </div>
    </>}
  </section>;
}

/**
 * Courier side of the live pin. The browser position is sent at most once every eight seconds
 * and only while a mission is running; switching off deletes the stored row on the server.
 */
export function useLocationSharing(token: string) {
  const [sharing, setSharing] = useState(false);
  const [error, setError] = useState('');
  const [lastSentAt, setLastSentAt] = useState<string | null>(null);
  const watchRef = useRef<number | null>(null);
  const lastPush = useRef(0);

  const stop = useCallback(async () => {
    if (watchRef.current !== null) { navigator.geolocation.clearWatch(watchRef.current); watchRef.current = null; }
    setSharing(false);
    try { await api('/api/v1/drivers/me/location', token, 'DELETE'); } catch { /* the row expires with the mission anyway */ }
  }, [token]);

  const start = useCallback(() => {
    setError('');
    if (!('geolocation' in navigator)) { setError('این مرورگر موقعیت مکانی را پشتیبانی نمی‌کند.'); return; }
    watchRef.current = navigator.geolocation.watchPosition(
      position => {
        const now = Date.now();
        if (now - lastPush.current < 8000) return;
        lastPush.current = now;
        setSharing(true);
        void api('/api/v1/drivers/me/location', token, 'POST', {
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracy: Number.isFinite(position.coords.accuracy) ? Math.round(position.coords.accuracy) : undefined,
        }).then(() => setLastSentAt(new Date().toISOString())).catch((e: Error) => { setError(e.message); void stop(); });
      },
      err => {
        setError(err.code === err.PERMISSION_DENIED ? 'اجازهٔ دسترسی به موقعیت مکانی داده نشد؛ از تنظیمات مرورگر فعال کنید.' : 'دریافت موقعیت مکانی ممکن نشد.');
        void stop();
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 },
    );
  }, [token, stop]);

  useEffect(() => () => { if (watchRef.current !== null) navigator.geolocation.clearWatch(watchRef.current); }, []);
  return { sharing, error, lastSentAt, start, stop };
}

type Verification = {
  status: 'UNVERIFIED' | 'PENDING' | 'APPROVED' | 'REJECTED';
  note: string | null; required: boolean; submittedAt: string | null; verifiedAt: string | null;
  idCardUrl: string | null; selfieUrl: string | null;
  history: Array<{ status: string; note: string | null; selfieMatch: boolean | null; createdAt: string }>;
};

const statusCopy: Record<string, { label: string; tone: string; hint: string }> = {
  UNVERIFIED: { label: 'ارسال‌نشده', tone: 'pending-pill', hint: 'برای دریافت مأموریت در حالت کنترل‌شده، کارت ملی و سلفی خود را بفرستید.' },
  PENDING: { label: 'در انتظار بررسی', tone: 'pending-pill', hint: 'مدارک شما رسیده است؛ نتیجه از همین صفحه اعلام می‌شود.' },
  APPROVED: { label: 'تأییدشده', tone: 'verified-pill', hint: 'مدارک شما تأیید شده است.' },
  REJECTED: { label: 'تأییدنشده', tone: 'error-pill', hint: 'مدارک تأیید نشد؛ می‌توانید دوباره ارسال کنید.' },
};

/** Courier documents: national ID card plus a fresh selfie that a human compares. */
export function DriverVerificationPanel({ token }: { token: string }) {
  const [data, setData] = useState<Verification | null>(null);
  const [idCard, setIdCard] = useState<string | null>(null);
  const [selfie, setSelfie] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    try { setData(await api<Verification>('/api/v1/drivers/me/verification', token)); } catch (e) { setError((e as Error).message); }
  }, [token]);
  useEffect(() => { void load(); }, [load]);

  const submit = async () => {
    if (!idCard || !selfie) { setError('تصویر کارت ملی و عکس سلفی هر دو لازم است.'); return; }
    setBusy(true); setError(''); setNotice('');
    try {
      await api('/api/v1/drivers/me/verification', token, 'POST', { idCardUrl: idCard, selfieUrl: selfie });
      setIdCard(null); setSelfie(null);
      setNotice('مدارک ارسال شد؛ بررسی معمولاً کمتر از یک روز کاری طول می‌کشد.');
      await load();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  const copy = statusCopy[data?.status ?? 'UNVERIFIED'];
  const canSubmit = data && data.status !== 'PENDING' && data.status !== 'APPROVED';
  return <section className="admin-card verification-card">
    <div className="driver-profile-head">
      <div><h2><UserCheck size={18} /> تأیید هویت من</h2><p>کارت ملی و یک سلفی تازه بفرستید؛ کارشناس جتینو سلفی را با عکس پروفایل و کارت ملی مقایسه می‌کند.</p></div>
      {data && <span className={`status-pill ${copy.tone}`}>{data.status === 'APPROVED' ? <BadgeCheck size={14} /> : <Clock3 size={14} />}{copy.label}</span>}
    </div>
    {data?.required && data.status !== 'APPROVED' && <p className="verification-warning"><AlertTriangle size={14} />فعال‌سازی مأموریت در حالت کنترل‌شده تا تأیید مدارک انجام نمی‌شود.</p>}
    {data && <p className="verification-hint">{copy.hint}{data.note ? ` دلیل بررسی: ${data.note}` : ''}{data.verifiedAt ? ` · تأیید در ${clock(data.verifiedAt)}` : ''}</p>}
    {error && <p className="photo-field-error" role="alert">{error}</p>}
    {notice && <p className="feedback success" role="status">{notice}</p>}
    {canSubmit ? <div className="verification-form">
      <PhotoField label="تصویر کارت ملی" hint="روی کارت ملی؛ شمارهٔ ملی و نام باید خوانا باشد." value={idCard} onChange={setIdCard} disabled={busy} />
      <PhotoField label="عکس سلفی" hint="روی چهرهٔ خودتان، بدون کلاه و عینک تیره؛ همین عکس با عکس پروفایل مقایسه می‌شود." value={selfie} onChange={setSelfie} disabled={busy} />
      <button type="button" className="primary-button" disabled={busy || !idCard || !selfie} onClick={() => void submit()}><ImageUp size={16} />{busy ? 'در حال ارسال…' : 'ارسال مدارک برای بررسی'}</button>
    </div> : data?.status === 'PENDING' ? <p className="verification-hint">نیازی به ارسال دوباره نیست.</p> : null}
    {data && data.history.length > 0 && <div className="verification-history">
      <h3>سابقهٔ بررسی</h3>
      {data.history.map((item, index) => <p key={index} className="history-row"><Clock3 size={13} />{statusCopy[item.status]?.label ?? item.status}{item.selfieMatch ? ' · تطبیق سلفی تأیید شد' : ''}{item.note ? ` · ${item.note}` : ''} · {clock(item.createdAt)}</p>)}
    </div>}
  </section>;
}

type QueueRow = { id: string; fullName: string | null; plateNumber: string | null; vehicleType: string | null; photoUrl: string | null; idCardUrl: string | null; selfieUrl: string | null; verificationStatus: string; verificationNote: string | null; submittedAt: string | null; phone: string; regionName: string };

/** Operations review: three pictures side by side and one explicit decision. */
export function AdminDriverVerification({ token }: { token: string }) {
  const [rows, setRows] = useState<QueueRow[]>([]);
  const [status, setStatus] = useState('PENDING');
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [matches, setMatches] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async (next = status) => {
    setError('');
    try { setRows(await api<QueueRow[]>(`/api/v1/admin/drivers/verification?status=${encodeURIComponent(next)}`, token)); }
    catch (e) { setError((e as Error).message); }
  }, [token, status]);
  useEffect(() => { void load(); }, [load]);

  const decide = async (row: QueueRow, decision: 'APPROVED' | 'REJECTED') => {
    setBusy(row.id); setError(''); setNotice('');
    try {
      await api(`/api/v1/admin/drivers/verification/${row.id}`, token, 'PATCH', { status: decision, note: (notes[row.id] ?? '').trim() || undefined, selfieMatch: matches[row.id] === true });
      setNotice(decision === 'APPROVED' ? 'مدارک تأیید شد و به راننده اطلاع داده شد.' : 'رد مدارک ثبت و دلیل برای راننده ارسال شد.');
      await load();
    } catch (e) { setError((e as Error).message); } finally { setBusy(''); }
  };

  return <section className="admin-card verification-card">
    <div className="settings-title"><div><h2><ShieldCheck size={18} /> تأیید مدارک پیک</h2><p>سلفی، عکس پروفایل و کارت ملی را مقایسه کنید؛ تأیید بدون تطبیق سلفی ممکن نیست.</p></div>
      <div className="report-controls"><select aria-label="وضعیت صف بررسی" value={status} onChange={e => { setStatus(e.target.value); void load(e.target.value); }}>
        <option value="PENDING">در انتظار بررسی</option><option value="APPROVED">تأییدشده</option><option value="REJECTED">ردشده</option><option value="UNVERIFIED">ارسال‌نشده</option>
      </select><button className="refresh-button" onClick={() => void load()}><Clock3 size={14} />به‌روزرسانی</button></div>
    </div>
    {error && <div className="feedback error" role="alert">{error}</div>}
    {notice && <div className="feedback success" role="status">{notice}</div>}
    {rows.length === 0 ? <p className="empty-note">موردی در این وضعیت نیست.</p> : rows.map(row => <article className="verification-row" key={row.id}>
      <div className="verification-photos">
        {([['پروفایل', row.photoUrl, 'عکس پروفایل راننده'], ['سلفی', row.selfieUrl, 'سلفی ارسالی'], ['کارت ملی', row.idCardUrl, 'کارت ملی']] as const).map(([label, url, alt]) => <figure key={label}>
          {url ? <img src={url} alt={alt} /> : <span className="verification-missing">ثبت نشده</span>}
          <figcaption>{label}</figcaption>
        </figure>)}
      </div>
      <div className="verification-meta">
        <b>{row.fullName || 'بدون نام'} {row.plateNumber ? <span className="plate-number" dir="ltr">{row.plateNumber}</span> : null}</b>
        <small dir="ltr">{row.phone}</small>
        <small>{row.regionName} · ارسال {clock(row.submittedAt)}</small>
        {status === 'PENDING' ? <>
          <label className="match-check"><input type="checkbox" checked={matches[row.id] === true} onChange={e => setMatches(current => ({ ...current, [row.id]: e.target.checked }))} />سلفی با عکس پروفایل و کارت ملی مطابقت دارد</label>
          <input className="checkout-input" maxLength={300} value={notes[row.id] ?? ''} onChange={e => setNotes(current => ({ ...current, [row.id]: e.target.value }))} placeholder="توضیح برای راننده (در صورت رد الزامی است)" />
          <div className="verification-actions">
            <button className="approve-button" disabled={busy === row.id || matches[row.id] !== true} onClick={() => void decide(row, 'APPROVED')}><BadgeCheck size={14} />تأیید</button>
            <button className="reject-button" disabled={busy === row.id} onClick={() => void decide(row, 'REJECTED')}><ShieldX size={14} />رد</button>
          </div>
        </> : <small>{row.verificationNote || 'بدون توضیح'}</small>}
      </div>
    </article>)}
  </section>;
}

type SafetyRow = { id: string; orderId: string | null; category: string; note: string | null; status: string; createdAt: string; raisedRole: string; resolution: string | null; raisedPhone: string; driverPlate: string | null; driverName: string | null };
const roleLabel: Record<string, string> = { CUSTOMER: 'مشتری', BUSINESS: 'کسب‌وکار', DRIVER: 'پیک' };

/** The operations queue behind the emergency button. Oldest open report first. */
export function AdminSafetyBoard({ token }: { token: string }) {
  const [rows, setRows] = useState<SafetyRow[]>([]);
  const [status, setStatus] = useState('OPEN');
  const [resolution, setResolution] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async (next = status) => {
    setError('');
    try { setRows(await api<SafetyRow[]>(`/api/v1/admin/safety/events?status=${encodeURIComponent(next)}`, token)); }
    catch (e) { setError((e as Error).message); }
  }, [token, status]);
  useEffect(() => { void load(); }, [load]);

  const act = async (row: SafetyRow, next: 'ACKNOWLEDGED' | 'RESOLVED') => {
    setBusy(row.id); setError('');
    try {
      await api(`/api/v1/admin/safety/events/${row.id}`, token, 'PATCH', { status: next, resolution: (resolution[row.id] ?? '').trim() || undefined });
      await load();
    } catch (e) { setError((e as Error).message); } finally { setBusy(''); }
  };

  return <section className="admin-card safety-board">
    <div className="settings-title"><div><h2><Siren size={18} /> گزارش‌های ایمنی</h2><p>هر گزارش تا بسته‌شدن با نتیجهٔ مکتوب در این صف می‌ماند.</p></div>
      <div className="report-controls"><select aria-label="وضعیت گزارش‌ها" value={status} onChange={e => { setStatus(e.target.value); void load(e.target.value); }}>
        <option value="OPEN">باز</option><option value="ACKNOWLEDGED">در حال بررسی</option><option value="RESOLVED">بسته‌شده</option>
      </select><button className="refresh-button" onClick={() => void load()}><Clock3 size={14} />به‌روزرسانی</button></div>
    </div>
    {error && <div className="feedback error" role="alert">{error}</div>}
    {rows.length === 0 ? <p className="empty-note">گزارشی در این وضعیت نیست.</p> : rows.map(row => <article className={`safety-row status-${row.status.toLowerCase()}`} key={row.id}>
      <div className="safety-row-head"><span className={`status-pill ${row.status === 'OPEN' ? 'error-pill' : 'pending-pill'}`}>{categories.find(([value]) => value === row.category)?.[1] ?? row.category}</span><small>{clock(row.createdAt)}</small></div>
      <div className="safety-row-info">
        <span>ثبت‌کننده: <b>{roleLabel[row.raisedRole] ?? row.raisedRole} <span dir="ltr">{row.raisedPhone}</span></b></span>
        {row.orderId && <span>سفارش <b dir="ltr">{row.orderId.slice(0, 8).toUpperCase()}</b></span>}
        {row.driverName && <span>پیک <b>{row.driverName}{row.driverPlate ? ` · ${row.driverPlate}` : ''}</b></span>}
        {row.note && <span>توضیح: <b>{row.note}</b></span>}
        {row.resolution && <span>نتیجه: <b>{row.resolution}</b></span>}
      </div>
      {row.status !== 'RESOLVED' && <div className="safety-row-actions">
        <input className="checkout-input" maxLength={300} value={resolution[row.id] ?? ''} onChange={e => setResolution(current => ({ ...current, [row.id]: e.target.value }))} placeholder="نتیجهٔ پیگیری (برای بستن الزامی است)" />
        {row.status === 'OPEN' && <button className="refresh-button" disabled={busy === row.id} onClick={() => void act(row, 'ACKNOWLEDGED')}>برداشتن گزارش</button>}
        <button className="approve-button" disabled={busy === row.id} onClick={() => void act(row, 'RESOLVED')}>بستن با نتیجه</button>
      </div>}
    </article>)}
  </section>;
}
