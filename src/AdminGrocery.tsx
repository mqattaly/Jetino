import { useEffect, useState } from 'react';
import { CreditCard, Landmark, Save, ShieldCheck, Wallet } from 'lucide-react';

type GrocerySettings = {
  bidMinutes: number; paymentMinutes: number; revenueMode: 'NONE' | 'FEE_PERCENT' | 'GOODS_PERCENT' | 'FIXED';
  feeBps: number; goodsBps: number; fixedRial: string; paymentMode: 'CARD_TO_CARD' | 'GATEWAY';
  extendMinutes: number; maxExtensions: number;
  platformCard: string | null; platformSheba: string | null; platformHolder: string | null;
  platformBank: string | null; gatewayEnabled: boolean;
};
type FeeRow = {
  id: string; storeName: string | null; feeRial: string; feeReference: string | null;
  feeDeclaredAt: string | null; feeReceiptUrl: string | null; customerName: string | null; customerPhone: string | null;
};
type GoodsRow = { id: string; storeName: string | null; invoiceAmountRial: string; paymentDeclaredAt: string | null; paymentConfirmedAt: string | null; customerName: string | null };

const faDigits = (value: string) => value.replace(/[0-9]/g, digit => '۰۱۲۳۴۵۶۷۸۹'[Number(digit)]);
const asciiDigits = (value: string) => value.replace(/[۰-۹]/g, digit => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit))).replace(/[٠-٩]/g, digit => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)));
const money = (value: string | null | undefined) => new Intl.NumberFormat('fa-IR').format(Number(value ?? 0));
const groupCard = (value: string) => asciiDigits(value).replace(/\D/g, '').slice(0, 16).replace(/(.{4})/g, '$1 ').trim();
const REVENUE_LABELS: Record<string, string> = {
  NONE: 'بدون کارمزد (فعلاً رایگان)', FEE_PERCENT: 'درصدی از کرایهٔ ماموریت',
  GOODS_PERCENT: 'درصدی از مبلغ کالا', FIXED: 'مبلغ ثابت به ازای هر ماموریت',
};

async function call<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error((payload as { message?: string } | null)?.message || 'درخواست ناموفق بود.');
  return payload as T;
}

/** کارت‌به‌کارت همیشه روشن است؛ درگاه فقط مسیر اضافه است. */
export default function AdminGrocery({ token }: { token: string }) {
  const [settings, setSettings] = useState<GrocerySettings | null>(null);
  const [fee, setFee] = useState('');
  const [goods, setGoods] = useState('');
  const [fixed, setFixed] = useState('');
  const [card, setCard] = useState('');
  const [sheba, setSheba] = useState('');
  const [holder, setHolder] = useState('');
  const [bank, setBank] = useState('');
  const [gateway, setGateway] = useState(false);
  const [revenueMode, setRevenueMode] = useState('NONE');
  const [queues, setQueues] = useState<{ feeQueue: FeeRow[]; goodsQueue: GoodsRow[] }>({ feeQueue: [], goodsQueue: [] });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const hydrate = (next: GrocerySettings) => {
    setSettings(next);
    setFee(String(next.feeBps / 100)); setGoods(String(next.goodsBps / 100)); setFixed(String(next.fixedRial));
    setCard(groupCard(next.platformCard ?? '')); setSheba(next.platformSheba ?? '');
    setHolder(next.platformHolder ?? ''); setBank(next.platformBank ?? '');
    setGateway(next.gatewayEnabled); setRevenueMode(next.revenueMode);
  };

  const load = async () => {
    setError('');
    try {
      const [current, receipts] = await Promise.all([
        call<GrocerySettings>('/api/v1/admin/grocery/settings', token),
        call<{ feeQueue: FeeRow[]; goodsQueue: GoodsRow[] }>('/api/v1/admin/grocery/receipts', token),
      ]);
      hydrate(current); setQueues(receipts);
    } catch (e) { setError((e as Error).message); }
  };
  useEffect(() => { void load(); }, [token]);

  const save = async () => {
    const toBps = (value: string, label: string) => {
      const parsed = Number(asciiDigits(value).replace(/[^\d.]/g, ''));
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) throw new Error(`${label} باید بین ۰ تا ۱۰۰ درصد باشد.`);
      return Math.round(parsed * 100);
    };
    setBusy(true); setError(''); setNotice('');
    try {
      const digitsCard = asciiDigits(card).replace(/\D/g, '');
      if (digitsCard && digitsCard.length !== 16) throw new Error('شمارهٔ کارت باید ۱۶ رقم باشد.');
      const cleanSheba = asciiDigits(sheba).replace(/\s/g, '').toUpperCase();
      if (cleanSheba && !/^IR\d{24}$/.test(cleanSheba)) throw new Error('شبا باید با IR شروع شود و ۲۴ رقم داشته باشد.');
      const updated = await call<GrocerySettings>('/api/v1/admin/grocery/settings', token, {
        method: 'PATCH',
        body: JSON.stringify({
          revenueMode, feeBps: toBps(fee, 'درصد کرایه'), goodsBps: toBps(goods, 'درصد کالا'),
          fixedRial: asciiDigits(fixed).replace(/\D/g, '') || '0',
          platformCard: digitsCard, platformSheba: cleanSheba,
          platformHolder: holder.trim(), platformBank: bank.trim(), gatewayEnabled: gateway,
        }),
      });
      hydrate(updated);
      setNotice('تنظیمات سوپرمارکت ذخیره و در سابقهٔ ممیزی ثبت شد.');
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  const confirmFee = async (id: string) => {
    setBusy(true); setError(''); setNotice('');
    try {
      await call(`/api/v1/admin/grocery/lists/${id}/fee/confirm`, token, { method: 'POST' });
      setNotice('کرایهٔ ماموریت تأیید شد و ماموریت برای خرید آزاد شد.');
      await load();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  return <section className="admin-card grocery-admin">
    <div className="report-heading"><div><h2><Wallet size={17}/> پرداخت و درآمد سوپرمارکت</h2><small>کارت‌به‌کارت همیشه در دسترس مشتری می‌ماند؛ درگاه فقط یک مسیر اضافه است.</small></div>
      <div className="report-controls"><button className="refresh-button" disabled={busy} onClick={() => void load()}>به‌روزرسانی</button></div></div>

    {error && <div className="feedback error" role="alert">{error}</div>}
    {notice && <div className="feedback success" role="status">{notice}</div>}

    {settings && <>
      <div className="grocery-admin-grid">
        <div>
          <label className="field-label" htmlFor="g-revenue-mode">مدل درآمد جتینو</label>
          <select id="g-revenue-mode" className="admin-input" value={revenueMode} onChange={e => setRevenueMode(e.target.value)}>
            {Object.entries(REVENUE_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
          </select>
        </div>
        <div>
          <label className="field-label" htmlFor="g-fixed">مبلغ ثابت هر ماموریت (ریال)</label>
          <input id="g-fixed" className="admin-input" inputMode="numeric" value={fixed} onChange={e => setFixed(asciiDigits(e.target.value).replace(/[^\d]/g, ''))} disabled={revenueMode !== 'FIXED'} placeholder="۰"/>
        </div>
        <div>
          <label className="field-label" htmlFor="g-fee">درصد از کرایهٔ ماموریت</label>
          <input id="g-fee" className="admin-input" inputMode="decimal" value={fee} onChange={e => setFee(asciiDigits(e.target.value).replace(/[^\d.]/g, ''))} disabled={revenueMode !== 'FEE_PERCENT'} placeholder="۱۰"/>
        </div>
        <div>
          <label className="field-label" htmlFor="g-goods">درصد از مبلغ کالا</label>
          <input id="g-goods" className="admin-input" inputMode="decimal" value={goods} onChange={e => setGoods(asciiDigits(e.target.value).replace(/[^\d.]/g, ''))} disabled={revenueMode !== 'GOODS_PERCENT'} placeholder="۵"/>
        </div>
        <div className="span-2">
          <label className="field-label" htmlFor="g-card"><CreditCard size={14}/> شمارهٔ کارت مقصد پلتفرم</label>
          <input id="g-card" className="admin-input ltr-input" inputMode="numeric" dir="ltr" value={card} onChange={e => setCard(groupCard(e.target.value))} placeholder="۶۰۳۷ ۹۹۷۷ ۱۲۳۴ ۵۶۷۸"/>
          <p className="grocery-hint ltr-hint">همین کارت به مشتری نشان داده می‌شود؛ خالی گذاشتن آن کارت‌به‌کارت را مخفی می‌کند.</p>
        </div>
        <div>
          <label className="field-label" htmlFor="g-holder"><ShieldCheck size={14}/> نام صاحب حساب</label>
          <input id="g-holder" className="admin-input" value={holder} onChange={e => setHolder(e.target.value)} placeholder="جتینو"/>
        </div>
        <div>
          <label className="field-label" htmlFor="g-bank"><Landmark size={14}/> بانک</label>
          <input id="g-bank" className="admin-input" value={bank} onChange={e => setBank(e.target.value)} placeholder="بانک ملت"/>
        </div>
        <div className="span-2">
          <label className="field-label" htmlFor="g-sheba">شبا (اختیاری)</label>
          <input id="g-sheba" className="admin-input ltr-input" dir="ltr" value={sheba} onChange={e => setSheba(asciiDigits(e.target.value).toUpperCase().replace(/[^IR\d]/g, ''))} placeholder="IR00 0000 0000 0000 0000 0000 00"/>
        </div>
        <div className="span-2">
          <label className="field-label switch-line" htmlFor="g-gateway">
            <input id="g-gateway" type="checkbox" checked={gateway} onChange={e => setGateway(e.target.checked)}/>
            <span>درگاه پرداخت آنلاین متصل است (کارت‌به‌کارت به هر حال فعال می‌ماند)</span>
          </label>
        </div>
      </div>
      <button className="primary-button" disabled={busy} onClick={() => void save()}>{busy ? 'در حال ذخیره…' : 'ذخیرهٔ تنظیمات سوپرمارکت'}<Save size={16}/></button>
    </>}

    <div className="grocery-admin-queue">
      <h3>صف رسید کرایهٔ ماموریت ({faDigits(String(queues.feeQueue.length))})</h3>
      {queues.feeQueue.length === 0 ? <p className="grocery-hint">رسیدی برای بررسی نیست.</p> : queues.feeQueue.map(row =>
        <div className="grocery-admin-row" key={row.id}>
          <div><b>{row.customerName ?? 'مشتری'} · {row.storeName ?? 'سوپرمارکت'}</b><small>{money(row.feeRial)} ریال · کد پیگیری {row.feeReference ?? '—'} · {row.customerPhone ?? ''}</small></div>
          <div className="grocery-list-actions">
            {row.feeReceiptUrl && <a className="text-button" href={row.feeReceiptUrl} target="_blank" rel="noreferrer">رسید</a>}
            <button className="primary-button" disabled={busy} onClick={() => void confirmFee(row.id)}>تأیید کرایه</button>
          </div>
        </div>)}
    </div>

    <div className="grocery-admin-queue">
      <h3>پرداخت‌های کالا</h3>
      {queues.goodsQueue.length === 0 ? <p className="grocery-hint">موردی ثبت نشده است.</p> : queues.goodsQueue.map(row =>
        <div className="grocery-admin-row" key={row.id}>
          <div><b>{row.customerName ?? 'مشتری'} · {row.storeName ?? 'سوپرمارکت'}</b><small>{money(row.invoiceAmountRial)} ریال · {row.paymentConfirmedAt ? 'تأیید پیک' : 'در انتظار تأیید پیک'}</small></div>
          <span className={`status-pill ${row.paymentConfirmedAt ? 'status-confirmed' : 'pending-pill'}`}>{row.paymentConfirmedAt ? 'تأییدشده' : 'در جریان'}</span>
        </div>)}
    </div>
  </section>;
}
