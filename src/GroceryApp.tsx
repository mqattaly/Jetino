import { useCallback, useEffect, useMemo, useState } from 'react';
import { SkeletonList } from './ui/motion';
import {
  BadgeCheck, Bike, CheckCircle2, ClipboardList, Clock3, Copy, MapPin, Plus, RefreshCw, ShieldCheck,
  ShoppingBasket, Store, Truck, XCircle,
} from 'lucide-react';
import { OtpLogin } from './OperationsApp';
import { BackButton } from './ui/controls';
import { PhotoField } from './PhotoField';
import { toPersianDigits } from './ui/plate';

type Bid = { id: string; amountRial: string; note: string | null; status: string; driverName: string | null; driverPlate: string | null };
type Item = { name: string; quantity: string; unit: string; unitPriceRial: string; lineTotalRial: string };
type CardBox = { enabled: boolean; card: string | null; sheba: string | null; holder: string | null; bank: string | null; note: string | null };
type Destination = { fee: { cardToCard: CardBox; online: { enabled: boolean; note: string } } };
type Row = {
  id: string; storeName: string | null; itemsText: string; status: string;
  feeRial: string | null; invoiceAmountRial: string | null; bidCount?: number;
  bidDeadlineAt: string | null; feeDeadlineAt: string | null; feeConfirmedAt: string | null;
  paymentDeadlineAt: string | null; createdAt: string;
};
type Detail = Row & {
  note: string | null; addressText: string; driverName: string | null; driverPlate: string | null;
  invoicePhotoUrl: string | null; storeCard: string | null; storeHolder: string | null;
  invoiceRejectReason: string | null; cancelReason: string | null; feeReference: string | null;
  bids: Bid[]; items: Item[]; paymentDestination: Destination | null;
  feeDue: boolean; canStartShopping: boolean;
};
type Address = { id: string; label: string; addressText: string; regionName: string };
type Shop = { id: string; name: string; addressText: string; regionName: string; productCount: number };

const money = (value: string | number | null) => value === null || value === undefined ? '—' : `${new Intl.NumberFormat('fa-IR').format(Number(value))} ریال`;
const fa = (value: string | number) => new Intl.NumberFormat('fa-IR').format(Number(value));
const ascii = (value: string) => value.replace(/[۰-۹]/g, d => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d))).replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
const faDigits = (value: string | number) => toPersianDigits(String(value));
const cardText = (value: string) => faDigits(value).replace(/(.{4})/g, '$1 ').trim();
const when = (value: string | null) => value ? new Intl.DateTimeFormat('fa-IR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value)) : '';

const STATUS: Record<string, { label: string; cls: string }> = {
  OPEN: { label: 'منتظر پیشنهاد پیک', cls: 'status-preparing' },
  ASSIGNED: { label: 'پیک انتخاب شد', cls: 'status-confirmed' },
  SHOPPING: { label: 'پیک تو فروشگاهه', cls: 'status-preparing' },
  INVOICE_SENT: { label: 'فاکتور آمادهٔ تأییده', cls: 'status-preparing' },
  AWAITING_PAYMENT: { label: 'منتظر پرداخت', cls: 'status-preparing' },
  PAID: { label: 'رسید ثبت شد', cls: 'status-confirmed' },
  PAYMENT_CONFIRMED: { label: 'پرداخت تأیید شد', cls: 'status-confirmed' },
  DELIVERED: { label: 'تحویل شد', cls: 'status-delivered' },
  CANCELLED: { label: 'لغو شد', cls: 'status-rejected' },
  EXPIRED: { label: 'پیشنهادی نیومد', cls: 'status-rejected' },
};

async function request<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      Authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((data as { message?: string }).message || 'درخواست انجام نشد.');
  return data as T;
}

function Countdown({ to }: { to: string | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  if (!to) return null;
  const left = Math.max(0, new Date(to).getTime() - now);
  const minutes = Math.floor(left / 60000);
  const seconds = Math.floor((left % 60000) / 1000);
  return <span className={`grocery-countdown${left === 0 ? ' done' : ''}`}>
    <Clock3 size={13} />{left === 0 ? 'مهلت تموم شد' : `${fa(minutes)}:${String(seconds).padStart(2, '0')} باقی مونده`}
  </span>;
}

function CopyLine({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return <button type="button" className="grocery-copy" onClick={async () => {
    try { await navigator.clipboard.writeText(value); setCopied(true); window.setTimeout(() => setCopied(false), 1600); } catch { /* clipboard blocked */ }
  }}>
    <span className="grocery-copy-text"><small>{label}</small><b dir="ltr">{value}</b></span>
    {copied ? <CheckCircle2 size={15} /> : <Copy size={15} />}
  </button>;
}

export default function GroceryApp() {
  const [token, setToken] = useState(() => sessionStorage.getItem('jetino_customer_token') || '');
  const [rows, setRows] = useState<Row[]>([]);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [addresses, setAddresses] = useState<Address[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [shellReady, setShellReady] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [shops, setShops] = useState<Shop[]>([]);
  const [form, setForm] = useState({ itemsText: '', storeName: '', storeId: '', note: '', addressId: '' });
  const [feeProof, setFeeProof] = useState<string | null>(null);
  const [feeRef, setFeeRef] = useState('');
  const [goodsProof, setGoodsProof] = useState<string | null>(null);
  const [goodsRef, setGoodsRef] = useState('');
  const [rejectReason, setRejectReason] = useState('');
  const [rejecting, setRejecting] = useState(false);

  const selectedId = detail?.id ?? '';

  const loadList = useCallback(async (auth = token) => {
    if (!auth) return;
    const data = await request<{ items: Row[] }>('/api/v1/grocery/lists/mine', auth);
    setRows(data.items ?? []);
  }, [token]);

  const loadDetail = useCallback(async (id: string, auth = token) => {
    if (!auth || !id) return;
    const data = await request<Detail>(`/api/v1/grocery/lists/${id}`, auth);
    setDetail(data);
  }, [token]);

  const loadAddresses = useCallback(async (auth = token) => {
    if (!auth) return;
    const data = await request<Address[]>('/api/v1/addresses', auth);
    setAddresses(data ?? []);
    setForm(current => current.addressId ? current : { ...current, addressId: data?.[0]?.id ?? '' });
  }, [token]);

  const loadShops = useCallback(async (auth = token) => {
    if (!auth) return;
    const data = await request<{ stores: Shop[] }>('/api/v1/grocery/stores', auth);
    setShops(data.stores ?? []);
  }, [token]);

  useEffect(() => {
    document.title = 'خرید خونه از سوپرمارکت | جتینو';
    if (!token) return;
    void Promise.all([loadList(token), loadAddresses(token), loadShops(token)]).catch((e: Error) => setError(e.message)).finally(() => setShellReady(true));
    const timer = window.setInterval(() => { void loadList(token).catch(() => { /* offline is fine */ }); if (selectedId) void loadDetail(selectedId, token).catch(() => { /* keep the last view */ }); }, 20_000);
    return () => window.clearInterval(timer);
  }, [token, loadList, loadAddresses, loadDetail, loadShops, selectedId]);

  const login = (auth: string) => { sessionStorage.setItem('jetino_customer_token', auth); setToken(auth); setError(''); };
  const logout = () => { sessionStorage.removeItem('jetino_customer_token'); setToken(''); setRows([]); setDetail(null); };

  const run = async (action: () => Promise<void>, message?: string) => {
    setBusy(true); setError(''); setNotice('');
    try { await action(); if (message) setNotice(message); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  const createList = () => run(async () => {
    const created = await request<Detail>('/api/v1/grocery/lists', token, {
      method: 'POST',
      headers: { 'Idempotency-Key': (crypto as Crypto & { randomUUID(): string }).randomUUID() },
      body: JSON.stringify({
        itemsText: form.itemsText,
        storeId: form.storeId || undefined,
        storeName: shops.length > 0 ? undefined : form.storeName || undefined,
        note: form.note || undefined,
        addressId: form.addressId,
      }),
    });
    setDetail(created); setOpen(false); setForm({ itemsText: '', storeName: '', storeId: '', note: '', addressId: form.addressId });
    await loadList();
    setNotice('لیست ثبت شد؛ پیک‌های منطقه تا ۱۵ دقیقه پیشنهاد می‌دن.');
  });

  const accept = (bidId: string) => run(async () => {
    setDetail(await request<Detail>(`/api/v1/grocery/lists/${selectedId}/bids/${bidId}/accept`, token, { method: 'POST' }));
    await loadList();
    setNotice('پیک انتخاب شد؛ کرایهٔ ماموریت رو حساب کن تا خرید شروع بشه.');
  });

  const payFee = () => run(async () => {
    if (!feeProof) throw new Error('عکس رسید پرداخت رو بذار.');
    setDetail(await request<Detail>(`/api/v1/grocery/lists/${selectedId}/fee-payment`, token, {
      method: 'POST', body: JSON.stringify({ method: 'CARD_TO_CARD', receiptUrl: feeProof, reference: ascii(feeRef) || undefined }),
    }));
    setFeeProof(null); setFeeRef('');
    setNotice('رسید کرایه ثبت شد؛ بعد از تأیید پشتیبانی، پیک خرید رو شروع می‌کنه.');
  });

  const approveInvoice = () => run(async () => {
    setDetail(await request<Detail>(`/api/v1/grocery/lists/${selectedId}/invoice/approve`, token, { method: 'POST' }));
    setNotice('فاکتور تأیید شد؛ حالا مبلغ کالا رو کارت‌به‌کارت کن.');
  });

  const rejectInvoice = () => run(async () => {
    setDetail(await request<Detail>(`/api/v1/grocery/lists/${selectedId}/invoice/reject`, token, {
      method: 'POST', body: JSON.stringify({ reason: rejectReason }),
    }));
    setRejecting(false); setRejectReason('');
    setNotice('اعتراض ثبت شد؛ پیک فاکتور رو اصلاح می‌کنه.');
  });

  const payGoods = () => run(async () => {
    if (!goodsProof) throw new Error('عکس رسید پرداخت رو بذار.');
    setDetail(await request<Detail>(`/api/v1/grocery/lists/${selectedId}/payment`, token, {
      method: 'POST', body: JSON.stringify({ method: 'CARD_TO_CARD', receiptUrl: goodsProof, reference: ascii(goodsRef) || undefined }),
    }));
    setGoodsProof(null); setGoodsRef('');
    setNotice('رسید ثبت شد؛ پیک بعد از تأیید فروشنده تأییدش می‌کنه.');
  });

  const cancel = () => run(async () => {
    setDetail(await request<Detail>(`/api/v1/grocery/lists/${selectedId}/cancel`, token, { method: 'POST', body: JSON.stringify({}) }));
    await loadList();
    setNotice('لیست لغو شد.');
  });

  const feeCard = detail?.paymentDestination?.fee.cardToCard;
  const online = detail?.paymentDestination?.fee.online;
  const status = detail ? STATUS[detail.status] ?? { label: detail.status, cls: '' } : null;
  const pendingBids = useMemo(() => (detail?.bids ?? []).filter(bid => bid.status === 'PENDING'), [detail]);

  return <div className="ops-page grocery-page" dir="rtl">
    <header className="ops-header">
      <a href="/" className="brand"><img className="brand-logo" src="/brand/logo.png" alt="" width="46" height="28" decoding="async"/><span>جتینو<small>خرید از سوپرمارکت</small></span></a>
      <div className="ops-header-actions">
        {token && <button className="logout-button" onClick={logout}>خروج</button>}
        <button className="refresh-button" disabled={busy} onClick={() => run(async () => { await loadList(); if (selectedId) await loadDetail(selectedId); })}>
          <RefreshCw size={14} />به‌روزرسانی
        </button>
      </div>
    </header>
    <main className="ops-main">
      <BackButton />
      <div className="ops-title">
        <div>
          <div className="eyebrow muted">لیست بده، پیک برات می‌خره</div>
          <h1>خرید از سوپرمارکت</h1>
          <p>لیست خریدتو بنویس؛ پیک‌های محلی قیمت ماموریت می‌دن، یکیشون رو انتخاب می‌کنی و خرید رو برات انجام می‌ده.</p>
          <a className="grocery-owner-link" href="/grocery/store"><Store size={14} />صاحب فروشگاهی؟ پنل فروشگاه</a>
        </div>
      </div>

      {!token && <OtpLogin onSuccess={(auth: string) => login(auth)} onError={setError} />}

      {token && <>
        {error && <div className="grocery-alert error" role="alert">{error}</div>}
        {notice && <div className="grocery-alert ok" role="status">{notice}</div>}

        <div className="grocery-actions">
          <button type="button" className="btn btn-primary" onClick={() => setOpen(value => !value)}>
            <Plus size={16} /><span>{open ? 'بستن فرم' : 'یه لیست خرید تازه'}</span>
          </button>
        </div>

        {open && <section className="grocery-card">
          <h2><ShoppingBasket size={18} />لیست جدید</h2>
          <label className="checkout-label">متن لیست<textarea className="checkout-input grocery-textarea" rows={5} value={form.itemsText}
            placeholder="مثلاً: ۲ کیلو سیب، یه شونه تخم‌مرغ، نان سنگک، ماست ۹۰۰ گرمی" onChange={e => setForm({ ...form, itemsText: e.target.value })} /></label>
          <div className="grocery-grid-2">
            {shops.length > 0
              ? <label className="checkout-label">فروشگاه<select className="checkout-input" value={form.storeId}
                  onChange={e => setForm({ ...form, storeId: e.target.value })}>
                  <option value="">فرقی نمی‌کنه؛ پیک خودش می‌ره</option>
                  {shops.map(shop => <option key={shop.id} value={shop.id}>{shop.name} — {shop.addressText}</option>)}
                </select></label>
              : <label className="checkout-label">نام فروشگاه (اختیاری)<input className="checkout-input" value={form.storeName}
                  placeholder="مثلاً هایپر مرکزی" onChange={e => setForm({ ...form, storeName: e.target.value })} /></label>}
            <label className="checkout-label">نشانی تحویل<select className="checkout-input" value={form.addressId} onChange={e => setForm({ ...form, addressId: e.target.value })}>
              {addresses.length === 0 && <option value="">نشانی ثبت نشده</option>}
              {addresses.map(address => <option key={address.id} value={address.id}>{address.label} — {address.addressText}</option>)}
            </select></label>
          </div>
          <label className="checkout-label">توضیح برای پیک (اختیاری)<input className="checkout-input" value={form.note}
            placeholder="مثلاً زنگ واحد ۲ رو بزن" onChange={e => setForm({ ...form, note: e.target.value })} /></label>
          <button type="button" className="btn btn-primary" disabled={busy || form.itemsText.trim().length < 5 || !form.addressId} onClick={() => void createList()}>
            <ClipboardList size={16} /><span>ثبت لیست و گرفتن پیشنهاد</span>
          </button>
          {addresses.length === 0 && <p className="grocery-hint">برای ثبت لیست، اول یه نشانی تو <a href="/orders">سفارش‌های من</a> ثبت کن.</p>}
          {shops.length === 0 && <p className="grocery-hint">هنوز فروشگاهی از طرف جتینو تأیید نشده؛ اسم فروشگاه رو خودت بنویس یا بذار پیک انتخاب کنه. <a href="/grocery/store">صاحب فروشگاهی؟ فروشگاهت رو ثبت کن</a></p>}
        </section>}

        <section className="grocery-card">
          <h2><ClipboardList size={18} />لیست‌های من</h2>
          {!shellReady && rows.length === 0 ? <SkeletonList rows={3} label="در حال خواندن لیست‌ها…"/> : rows.length === 0 && <p className="grocery-empty">هنوز لیستی ثبت نکردی.</p>}
          <div className="grocery-list">
            {rows.map(row => {
              const pill = STATUS[row.status] ?? { label: row.status, cls: '' };
              return <button key={row.id} type="button" className={`grocery-row${row.id === selectedId ? ' active' : ''}`} onClick={() => void run(async () => { await loadDetail(row.id); })}>
                <div>
                  <b>{row.storeName || 'فروشگاه با انتخاب پیک'}</b>
                  <small>{row.itemsText.slice(0, 68)}{row.itemsText.length > 68 ? '…' : ''}</small>
                </div>
                <div className="grocery-row-meta">
                  <span className={`status-pill ${pill.cls}`}>{pill.label}</span>
                  {row.status === 'OPEN' && <small>{fa(row.bidCount ?? 0)} پیشنهاد</small>}
                  {row.feeRial && <small>{money(row.feeRial)}</small>}
                  <small>{when(row.createdAt)}</small>
                </div>
              </button>;
            })}
          </div>
        </section>

        {detail && <section className="grocery-card grocery-detail">
          <div className="grocery-detail-head">
            <h2><Store size={18} />{detail.storeName || 'فروشگاه با انتخاب پیک'}</h2>
            {status && <span className={`status-pill ${status.cls}`}>{status.label}</span>}
          </div>
          <p className="grocery-items-text">{detail.itemsText}</p>
          <p className="grocery-address"><MapPin size={14} />{detail.addressText}</p>
          {detail.driverName && <p className="grocery-courier"><Bike size={14} />پیک: {detail.driverName}{detail.driverPlate ? <> · پلاک <span dir="ltr">{faDigits(detail.driverPlate)}</span></> : null}</p>}
          {detail.note && <p className="grocery-hint">یادداشت: {detail.note}</p>}

          {detail.status === 'OPEN' && <>
            <div className="grocery-deadline">مهلت پیشنهاد: <Countdown to={detail.bidDeadlineAt} /></div>
            {pendingBids.length === 0 && <p className="grocery-empty">هنوز پیشنهادی نیومده؛ چند دقیقهٔ دیگه یه سر بزن.</p>}
            <div className="grocery-bids">
              {pendingBids.map(bid => <div key={bid.id} className="grocery-bid">
                <div><b>{bid.driverName || 'پیک جتینو'}</b><small>{bid.driverPlate ? <span dir="ltr">{faDigits(bid.driverPlate)}</span> : 'پلاک ثبت نشده'}{bid.note ? ` · ${bid.note}` : ''}</small></div>
                <div className="grocery-bid-actions">
                  <strong>{money(bid.amountRial)}</strong>
                  <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void accept(bid.id)}>
                    <CheckCircle2 size={14} /><span>انتخاب</span>
                  </button>
                </div>
              </div>)}
            </div>
            <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void cancel()}><XCircle size={14} /><span>لغو لیست</span></button>
          </>}

          {detail.status === 'ASSIGNED' && <>
            <div className="grocery-fee-box">
              <h3><ShieldCheck size={16} />پیش‌پرداخت کرایهٔ ماموریت</h3>
              <p>مبلغ توافق‌شده: <b>{money(detail.feeRial)}</b></p>
              <p className="grocery-hint">که سفارش الکی پیش نیاد، کرایه قبل از شروع خرید حساب می‌شه. تا پشتیبانی تأیید نکنه، پیک خرید رو شروع نمی‌کنه.</p>
              {detail.feeConfirmedAt
                ? <div className="grocery-alert ok"><BadgeCheck size={16} />کرایه تأیید شد؛ پیک خرید رو شروع می‌کنه.</div>
                : detail.feeDeadlineAt && <div className="grocery-deadline">مهلت پرداخت کرایه: <Countdown to={detail.feeDeadlineAt} /></div>}
              {!detail.feeConfirmedAt && feeCard && <>
                {feeCard.enabled && <>
                  <div className="grocery-cards">
                    {feeCard.card && <CopyLine label="شمارهٔ کارت" value={cardText(feeCard.card)} />}
                    {feeCard.sheba && <CopyLine label="شبا" value={feeCard.sheba} />}
                    {feeCard.holder && <div className="grocery-card-owner"><small>صاحب حساب</small><b>{feeCard.holder}</b>{feeCard.bank ? <small>{feeCard.bank}</small> : null}</div>}
                  </div>
                  <PhotoField label="تصویر رسید پرداخت کرایه" hint="کارت‌به‌کارت به حساب بالا" value={feeProof} onChange={setFeeProof} />
                  <label className="checkout-label">شمارهٔ پیگیری (اختیاری)<input className="checkout-input" dir="ltr" value={feeRef} onChange={e => setFeeRef(e.target.value)} /></label>
                  <button type="button" className="btn btn-primary" disabled={busy || !feeProof} onClick={() => void payFee()}>
                    <ShieldCheck size={16} /><span>ثبت رسید کرایه</span>
                  </button>
                </>}
                {!feeCard.enabled && <div className="grocery-alert error">{feeCard.note || 'شمارهٔ کارت هنوز تنظیم نشده.'}</div>}
              </>}
              {online && <p className={`grocery-hint${online.enabled ? '' : ' muted'}`}>پرداخت آنلاین: {online.enabled ? 'در حال راه‌اندازی' : 'درگاه هنوز وصل نشده است'} — فعلاً کارت‌به‌کارت فعاله.</p>}
            </div>
          </>}

          {detail.status === 'INVOICE_SENT' && <>
            <div className="grocery-invoice">
              <h3>فاکتور خرید</h3>
              {detail.invoicePhotoUrl && <img className="grocery-invoice-photo" src={detail.invoicePhotoUrl} alt="تصویر فاکتور" />}
              <p>مبلغ فاکتور: <b>{money(detail.invoiceAmountRial)}</b></p>
              {detail.items.length > 0 && <ul className="grocery-invoice-items">
                {detail.items.map((item, index) => <li key={`${item.name}-${index}`}>
                  <span>{item.name}</span><small>{fa(item.quantity)} {item.unit} × {money(item.unitPriceRial)}</small><b>{money(item.lineTotalRial)}</b>
                </li>)}
              </ul>}
              {detail.storeCard && <CopyLine label="کارت فروشگاه" value={cardText(detail.storeCard)} />}
              {detail.storeHolder && <p className="grocery-hint">صاحب حساب فروشگاه: {detail.storeHolder}</p>}
              <div className="grocery-invoice-actions">
                <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void approveInvoice()}><CheckCircle2 size={16} /><span>تأیید فاکتور</span></button>
                <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setRejecting(value => !value)}><XCircle size={16} /><span>اعتراض دارم</span></button>
              </div>
              {rejecting && <div className="grocery-invoice-reject">
                <label className="checkout-label">دلیل اعتراض<input className="checkout-input" value={rejectReason} onChange={e => setRejectReason(e.target.value)} placeholder="مثلاً قیمت تخم‌مرغ اشتباهه" /></label>
                <button type="button" className="btn btn-danger btn-sm" disabled={busy || rejectReason.trim().length < 5} onClick={() => void rejectInvoice()}>ارسال اعتراض</button>
              </div>}
            </div>
          </>}

          {detail.status === 'AWAITING_PAYMENT' && <>
            <div className="grocery-invoice">
              <h3>پرداخت مبلغ کالا</h3>
              {detail.invoicePhotoUrl ? <img className="grocery-invoice-photo" src={detail.invoicePhotoUrl} alt="تصویر فاکتور" /> : null}
              <p>مبلغ: <b>{money(detail.invoiceAmountRial)}</b></p>
              {detail.items.length > 0 && <ul className="grocery-invoice-items">
                {detail.items.map((item, index) => <li key={`goods-${item.name}-${index}`}>
                  <span>{item.name}</span><small>{fa(item.quantity)} {item.unit} × {money(item.unitPriceRial)}</small><b>{money(item.lineTotalRial)}</b>
                </li>)}
              </ul>}
              <div className="grocery-deadline">مهلت پرداخت: <Countdown to={detail.paymentDeadlineAt} /></div>
              {detail.storeCard && <CopyLine label={`کارت فروشگاه (${detail.storeHolder || 'صاحب فروشگاه'})`} value={cardText(detail.storeCard)} />}
              <PhotoField label="تصویر رسید پرداخت" hint="کارت‌به‌کارت به کارت فروشگاه" value={goodsProof} onChange={setGoodsProof} />
              <label className="checkout-label">شمارهٔ پیگیری (اختیاری)<input className="checkout-input" dir="ltr" value={goodsRef} onChange={e => setGoodsRef(e.target.value)} /></label>
              <button type="button" className="btn btn-primary" disabled={busy || !goodsProof} onClick={() => void payGoods()}>
                <CheckCircle2 size={16} /><span>ثبت رسید پرداخت کالا</span>
              </button>
            </div>
          </>}

          {detail.status === 'PAID' && <div className="grocery-alert ok"><Clock3 size={16} />رسید ثبت شد؛ پیک با فروشنده هماهنگ می‌کنه و تأییدش می‌کنه.</div>}
          {detail.status === 'PAYMENT_CONFIRMED' && <div className="grocery-alert ok"><Truck size={16} />پرداخت تأیید شد؛ پیک تو راهِ خونه‌ست.</div>}
          {detail.status === 'DELIVERED' && <div className="grocery-alert ok"><BadgeCheck size={16} />این خرید تحویل شده.</div>}
          {(detail.status === 'CANCELLED' || detail.status === 'EXPIRED') && <div className="grocery-alert error">{detail.cancelReason || (detail.status === 'EXPIRED' ? 'تا آخر مهلت پیشنهادی نیومد.' : 'این لیست بسته شده.')}</div>}
          {detail.invoiceRejectReason && detail.status === 'SHOPPING' && <p className="grocery-hint">اعتراضت ثبت شد: {detail.invoiceRejectReason}</p>}
        </section>}
      </>}
    </main>
  </div>;
}
