import { useCallback, useEffect, useMemo, useState } from 'react';
import { SkeletonList } from './ui/motion';
import { Bike, Check, ClipboardList, Clock3, MapPin, RefreshCw, Send, ShoppingBasket, Store, Truck, XCircle } from 'lucide-react';
import { PhotoField } from './PhotoField';

type OpenList = {
  id: string; storeName: string | null; itemsText: string; note: string | null;
  addressText: string | null; instructions: string | null;
  bidDeadlineAt: string; createdAt: string; bidCount: number;
};
type MyBid = {
  id: string; storeName: string | null; itemsText: string; listStatus: string; addressText: string | null;
  bidDeadlineAt: string; amountRial: string; bidNote: string | null; bidAt: string;
};
type Mission = {
  id: string; storeName: string | null; itemsText: string; note: string | null; status: string;
  feeRial: string | null; invoiceAmountRial: string | null; invoiceRejectReason: string | null;
  addressText: string | null; paymentDeadlineAt: string | null; feeConfirmedAt: string | null;
  paymentReceiptUrl: string | null; createdAt: string;
};
type Board = { open: OpenList[]; assigned: Mission[]; myBids?: MyBid[] };
type Draft = { amount: string; note: string };
type InvoiceDraft = { amount: string; card: string; holder: string; photo: string | null };

const ascii = (value: string) => value
  .replace(/[۰-۹]/g, d => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
  .replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
const digitsOnly = (value: string) => ascii(value).replace(/[^\d]/g, '');
const fa = (value: number) => new Intl.NumberFormat('fa-IR').format(value);
const money = (value: string | number | null | undefined) => {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) return '—';
  return `${new Intl.NumberFormat('fa-IR').format(Number(text))} ریال`;
};
const when = (value: string | null) => value
  ? new Intl.DateTimeFormat('fa-IR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value))
  : '';
const remaining = (value: string | null, now: number) => {
  if (!value) return 'بدون مهلت';
  const minutes = Math.ceil((new Date(value).getTime() - now) / 60_000);
  if (!Number.isFinite(minutes)) return 'بدون مهلت';
  return minutes <= 0 ? 'مهلت تموم شد' : `${fa(minutes)} دقیقه مونده`;
};

const STATUS: Record<string, { label: string; cls: string }> = {
  ASSIGNED: { label: 'پیک انتخاب شد', cls: 'status-confirmed' },
  SHOPPING: { label: 'تو فروشگاهی', cls: 'status-preparing' },
  INVOICE_SENT: { label: 'منتظر تأیید فاکتور', cls: 'status-preparing' },
  AWAITING_PAYMENT: { label: 'منتظر پرداخت مشتری', cls: 'status-preparing' },
  PAID: { label: 'رسید مشتری رسیده', cls: 'status-confirmed' },
  PAYMENT_CONFIRMED: { label: 'پرداخت تأیید شد', cls: 'status-confirmed' },
  DELIVERED: { label: 'تحویل شد', cls: 'status-delivered' },
};

async function request<T>(path: string, token: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      Authorization: `Bearer ${token}`,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((data as { message?: string }).message || 'درخواست انجام نشد.');
  return data as T;
}

/**
 * The courier's half of the text-shopping mission: take a list from the board, run the shopping,
 * send the shop's invoice, confirm the money and hand the bags over. Everything here talks to the
 * same `/grocery` endpoints the customer page uses, so the two sides can never drift apart.
 */
export function DriverGrocery({ token }: { token: string }) {
  const [board, setBoard] = useState<Board | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [invoices, setInvoices] = useState<Record<string, InvoiceDraft>>({});

  const load = useCallback(async (auth = token) => {
    setLoading(true);
    setError('');
    try {
      setBoard(await request<Board>('/api/v1/grocery/board', auth));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { void load(token); }, [load, token]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const run = async (key: string, work: () => Promise<string>) => {
    setBusy(key); setError(''); setNotice('');
    try {
      setNotice(await work());
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  };

  const open = board?.open ?? [];
  const assigned = board?.assigned ?? [];
  const myBids = board?.myBids ?? [];
  const pendingBids = useMemo(() => myBids.filter(bid => bid.listStatus === 'OPEN'), [myBids]);

  const draftOf = (id: string): Draft => drafts[id] ?? { amount: '', note: '' };
  const setDraft = (id: string, patch: Partial<Draft>) =>
    setDrafts(current => ({ ...current, [id]: { ...(current[id] ?? { amount: '', note: '' }), ...patch } }));
  const invoiceOf = (id: string): InvoiceDraft => invoices[id] ?? { amount: '', card: '', holder: '', photo: null };
  const setInvoice = (id: string, patch: Partial<InvoiceDraft>) =>
    setInvoices(current => ({ ...current, [id]: { ...(current[id] ?? { amount: '', card: '', holder: '', photo: null }), ...patch } }));

  const placeBid = (list: OpenList) => {
    const draft = draftOf(list.id);
    void run(`bid-${list.id}`, async () => {
      await request(`/api/v1/grocery/lists/${list.id}/bids`, token, 'POST', {
        amountRial: digitsOnly(draft.amount),
        note: draft.note.trim() || undefined,
      });
      setDrafts(current => { const next = { ...current }; delete next[list.id]; return next; });
      return 'پیشنهادت رفت؛ تا آخر مهلت منتظر جواب مشتری باش.';
    });
  };

  const startShopping = (mission: Mission) => void run(`start-${mission.id}`, async () => {
    await request(`/api/v1/grocery/lists/${mission.id}/status`, token, 'POST', { status: 'SHOPPING' });
    return 'خرید شروع شد؛ وقتی از فروشگاه فاکتور گرفتی، همینجا بفرستش.';
  });

  const submitInvoice = (mission: Mission) => {
    const draft = invoiceOf(mission.id);
    void run(`invoice-${mission.id}`, async () => {
      await request(`/api/v1/grocery/lists/${mission.id}/invoice`, token, 'POST', {
        amountRial: digitsOnly(draft.amount),
        storeCard: digitsOnly(draft.card),
        storeHolder: draft.holder.trim(),
        photoUrl: draft.photo,
      });
      setInvoices(current => { const next = { ...current }; delete next[mission.id]; return next; });
      return 'فاکتور رفت برای مشتری؛ منتظر تأییدش باش.';
    });
  };

  const confirmReceipt = (mission: Mission) => void run(`confirm-${mission.id}`, async () => {
    await request(`/api/v1/grocery/lists/${mission.id}/payment/confirm`, token, 'POST');
    return 'دریافت پول تأیید شد؛ حالا خرید رو ببر دمِ خونه.';
  });

  const deliver = (mission: Mission) => void run(`deliver-${mission.id}`, async () => {
    await request(`/api/v1/grocery/lists/${mission.id}/status`, token, 'POST', { status: 'DELIVERED' });
    return 'تحویل ثبت شد؛ دستت درد نکنه.';
  });

  const cancelMission = (mission: Mission) => {
    const reason = window.prompt('دلیل لغو ماموریت رو بنویس (حداقل ۵ حرف):')?.trim();
    if (!reason || reason.length < 5) return;
    void run(`cancel-${mission.id}`, async () => {
      await request(`/api/v1/grocery/lists/${mission.id}/status`, token, 'POST', { status: 'CANCELLED', reason });
      return 'ماموریت لغو شد؛ کرایهٔ پرداختشده به کیف پول مشتری برمیگرده.';
    });
  };

  const missionActions = (mission: Mission) => {
    const key = (name: string) => busy === `${name}-${mission.id}`;
    if (mission.status === 'ASSIGNED') {
      return <div className="dg-actions">
        <small className="dg-sum">{mission.feeConfirmedAt ? 'کرایه تأیید شده؛ می‌تونی بری خرید.' : 'منتظر تأیید کرایه توسط پشتیبانی.'}</small>
        <div className="dg-actions-row">
          <button className="approve-button" disabled={!mission.feeConfirmedAt || key('start')} onClick={() => startShopping(mission)}>
            <Bike size={14}/>{key('start') ? 'دارم شروع می‌کنم…' : 'شروع خرید'}
          </button>
          <button className="reject-button" disabled={Boolean(busy)} onClick={() => cancelMission(mission)}>
            <XCircle size={14}/>لغو ماموریت
          </button>
        </div>
      </div>;
    }
    if (mission.status === 'SHOPPING') {
      const draft = invoiceOf(mission.id);
      return <div className="dg-form">
        <p className="dg-wait">فاکتور فروشگاه رو بفرست؛ مشتری بعد از دیدنش پول کالا رو کارت‌به‌کارت می‌کنه.</p>
        <label className="checkout-label">مبلغ فاکتور (ریال)
          <input className="checkout-input" dir="ltr" inputMode="numeric" value={draft.amount}
            onChange={e => setInvoice(mission.id, { amount: digitsOnly(e.target.value) })} placeholder="۲۴۵۰۰۰۰"/>
        </label>
        <label className="checkout-label">شمارهٔ کارت فروشگاه
          <input className="checkout-input" dir="ltr" inputMode="numeric" maxLength={16} value={draft.card}
            onChange={e => setInvoice(mission.id, { card: digitsOnly(e.target.value).slice(0, 16) })} placeholder="۶۰۳۷۹۹۹۹۹۹۹۹۹۹۹۹"/>
        </label>
        <label className="checkout-label">نام صاحب حساب فروشگاه
          <input className="checkout-input" maxLength={120} value={draft.holder}
            onChange={e => setInvoice(mission.id, { holder: e.target.value })} placeholder="مثلاً فروشگاه رضایی"/>
        </label>
        <PhotoField label="عکس فاکتور فروشگاه" value={draft.photo} disabled={Boolean(busy)}
          alt="عکس فاکتور" onChange={photo => setInvoice(mission.id, { photo })}/>
        <div className="dg-actions">
          <small className="dg-sum">{draft.amount ? `جمع فاکتور: ${money(draft.amount)}` : 'مبلغ فاکتور رو به ریال بنویس'}</small>
          <div className="dg-actions-row">
            <button className="approve-button"
              disabled={key('invoice') || digitsOnly(draft.amount).length < 4 || digitsOnly(draft.card).length !== 16 || draft.holder.trim().length < 3}
              onClick={() => submitInvoice(mission)}>
              <Send size={14}/>{key('invoice') ? 'دارم می‌فرستم…' : 'فرستادن فاکتور'}
            </button>
            <button className="reject-button" disabled={Boolean(busy)} onClick={() => cancelMission(mission)}>
              <XCircle size={14}/>لغو ماموریت
            </button>
          </div>
        </div>
      </div>;
    }
    if (mission.status === 'INVOICE_SENT' || mission.status === 'AWAITING_PAYMENT') {
      return <div className="dg-actions">
        <small className="dg-sum">{mission.status === 'INVOICE_SENT'
          ? 'منتظر تأیید فاکتور توسط مشتری.'
          : `منتظر کارت‌به‌کارت مشتری${mission.paymentDeadlineAt ? ` · ${remaining(mission.paymentDeadlineAt, now)}` : ''}.`}</small>
        <button className="reject-button" disabled={Boolean(busy)} onClick={() => cancelMission(mission)}>
          <XCircle size={14}/>لغو ماموریت
        </button>
      </div>;
    }
    if (mission.status === 'PAID') {
      return <div className="dg-actions">
        <div>
          <small className="dg-sum">مشتری رسید پرداخت رو فرستاده؛ بعد از دیدن حساب، تأیید کن.</small>
          {mission.paymentReceiptUrl && <a className="dg-receipt" href={mission.paymentReceiptUrl} target="_blank" rel="noreferrer">دیدن رسید مشتری</a>}
        </div>
        <button className="approve-button" disabled={key('confirm')} onClick={() => confirmReceipt(mission)}>
          <Check size={14}/>{key('confirm') ? 'دارم تأیید می‌کنم…' : 'مبلغ رو گرفتم'}
        </button>
      </div>;
    }
    if (mission.status === 'PAYMENT_CONFIRMED') {
      return <div className="dg-actions">
        <small className="dg-sum">پول تأیید شده؛ خرید رو ببر و تحویل بده.</small>
        <button className="approve-button" disabled={key('deliver')} onClick={() => deliver(mission)}>
          <Truck size={14}/>{key('deliver') ? 'دارم ثبت می‌کنم…' : 'تحویل دادم'}
        </button>
      </div>;
    }
    return null;
  };

  return <section className="driver-grocery" id="grocery-missions">
    <div className="dg-head">
      <div>
        <h2><ShoppingBasket size={18}/> لیست‌های خرید سوپرمارکت</h2>
        <p>لیست‌های منطقهٔ خودت. کرایه رو پیشنهاد بده، خرید رو انجام بده، فاکتور رو بفرست و آخرش تحویل بده.</p>
      </div>
      <button className="refresh-button" onClick={() => void load()} disabled={loading}>
        <RefreshCw size={14}/>{loading ? 'دارم می‌گیرم…' : 'به‌روزرسانی'}
      </button>
    </div>
    {error && <div className="feedback error" role="alert">{error}</div>}
    {notice && <div className="feedback success">{notice}</div>}

    <h3 className="dg-title"><ClipboardList size={16}/> لیست‌های باز <span className="dg-count">{fa(open.length)}</span></h3>
    {loading && !board
      ? <SkeletonList rows={3} label="دارم لیست‌ها رو می‌گیرم…"/>
      : open.length === 0
        ? <p className="dg-empty">الان لیست بازی تو منطقه‌ت نیست؛ چند دقیقهٔ دیگه یه سر بزن.</p>
        : <div className="dg-list">{open.map(list => {
          const draft = draftOf(list.id);
          const waiting = busy === `bid-${list.id}`;
          return <article className="dg-card" key={list.id}>
            <div className="dg-card-top">
              <div>
                <b><Store size={14}/> {list.storeName || 'فروشگاه آزاد'}</b>
                <small>{when(list.createdAt)} · {fa(list.bidCount)} پیشنهاد تا حالا</small>
              </div>
              <span className="dg-clock"><Clock3 size={13}/>{remaining(list.bidDeadlineAt, now)}</span>
            </div>
            <p className="dg-items">{list.itemsText}</p>
            <div className="dg-meta">
              <MapPin size={13}/>
              <span>{list.addressText || 'نشانی ثبت نشده'}{list.instructions && <small>{list.instructions}</small>}</span>
            </div>
            {list.note && <p className="dg-note">یادداشت مشتری: {list.note}</p>}
            <div className="dg-form">
              <label className="checkout-label">کرایه‌ای که پیشنهاد می‌دی (ریال)
                <input className="checkout-input" dir="ltr" inputMode="numeric" value={draft.amount}
                  onChange={e => setDraft(list.id, { amount: digitsOnly(e.target.value) })} placeholder="۱۵۰۰۰۰"/>
              </label>
              <label className="checkout-label">توضیح برای مشتری (اختیاری)
                <input className="checkout-input" maxLength={200} value={draft.note}
                  onChange={e => setDraft(list.id, { note: e.target.value })} placeholder="مثلاً تا نیم ساعت دیگه خریدت تمومه"/>
              </label>
              <div className="dg-actions">
                <small className="dg-sum">{draft.amount ? `پیشنهادت: ${money(draft.amount)}` : 'مبلغ رو به ریال بنویس'}</small>
                <button className="approve-button" disabled={waiting || digitsOnly(draft.amount).length < 4} onClick={() => placeBid(list)}>
                  <Send size={14}/>{waiting ? 'دارم می‌فرستم…' : 'پیشنهاد بده'}
                </button>
              </div>
            </div>
          </article>;
        })}</div>}

    {pendingBids.length > 0 && <>
      <h3 className="dg-title"><Clock3 size={16}/> پیشنهادهایی که منتظر جوابن <span className="dg-count">{fa(pendingBids.length)}</span></h3>
      <div className="dg-list">{pendingBids.map(bid => <article className="dg-card" key={bid.id}>
        <div className="dg-card-top">
          <div>
            <b><Store size={14}/> {bid.storeName || 'فروشگاه آزاد'}</b>
            <small>{when(bid.bidAt)} · {remaining(bid.bidDeadlineAt, now)}</small>
          </div>
          <span className="status-pill status-preparing">منتظر جواب</span>
        </div>
        <p className="dg-items">{bid.itemsText}</p>
        <div className="dg-money">
          <span>پیشنهاد تو: <b>{money(bid.amountRial)}</b></span>
          {bid.bidNote && <span>{bid.bidNote}</span>}
        </div>
      </article>)}</div>
    </>}

    <h3 className="dg-title"><ShoppingBasket size={16}/> خریدهایی که دستته <span className="dg-count">{fa(assigned.length)}</span></h3>
    {assigned.length === 0
      ? <p className="dg-empty">هنوز خرید فعالی نداری. وقتی مشتری پیشنهادت رو قبول کنه، این‌جا میاد.</p>
      : <div className="dg-list">{assigned.map(mission => <article className="dg-card dg-mission" key={mission.id}>
        <div className="dg-card-top">
          <div>
            <b><Store size={14}/> {mission.storeName || 'فروشگاه آزاد'}</b>
            <small>#{mission.id.slice(0, 8).toUpperCase()} · {when(mission.createdAt)}</small>
          </div>
          <span className={`status-pill ${STATUS[mission.status]?.cls ?? ''}`}>{STATUS[mission.status]?.label ?? mission.status}</span>
        </div>
        <p className="dg-items">{mission.itemsText}</p>
        <div className="dg-meta">
          <MapPin size={13}/>
          <span>{mission.addressText || 'نشانی ثبت نشده'}</span>
        </div>
        <div className="dg-money">
          <span>کرایه: <b>{money(mission.feeRial)}</b></span>
          {mission.invoiceAmountRial && <span>فاکتور: <b>{money(mission.invoiceAmountRial)}</b></span>}
        </div>
        {mission.status === 'ASSIGNED' && !mission.feeConfirmedAt &&
          <p className="dg-wait">کرایه هنوز تأیید نشده. تا پشتیبانی تأیید نکنه، خرید رو شروع نکن.</p>}
        {mission.invoiceRejectReason &&
          <p className="dg-wait warn">مشتری به فاکتور اعتراض کرد: {mission.invoiceRejectReason} — درستش کن و دوباره بفرست.</p>}
        {mission.status === 'SHOPPING' && mission.invoiceRejectReason && <p className="dg-wait">فاکتور اصلاح‌شده رو از فرم پایین بفرست.</p>}
        {missionActions(mission)}
      </article>)}</div>}
  </section>;
}
