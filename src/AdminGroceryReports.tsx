import { useCallback, useEffect, useMemo, useState } from 'react';
import { SkeletonTable } from './ui/motion';
import { AlertTriangle, BarChart3, CalendarDays, Download, RefreshCw, Wallet } from 'lucide-react';

type ModelRow = { mode: string; lists: string; delivered: string; feesRial: string; goodsRial: string; platformRial: string };
type DayRow = { day: string; lists: string; delivered: string; feesRial: string; goodsRial: string; platformRial: string };
type QueueRow = {
  id: string; storeName: string | null; status: string; feeRial: string | null; invoiceAmountRial: string | null;
  feeDeclaredAt: string | null; paymentDeclaredAt: string | null; feeConfirmedAt: string | null;
  paymentReceiptUrl: string | null; customerPhone: string | null;
};
type Report = {
  currency: string; from: string; to: string; days: number; generatedAt: string;
  totals: Record<string, string | undefined>;
  byModel: ModelRow[];
  daily: DayRow[];
  attention: Record<string, string | undefined>;
  queue: QueueRow[];
};

const MODEL_LABELS: Record<string, string> = {
  NONE: 'بدون کارمزد',
  FEE_PERCENT: 'درصدی از کرایه',
  GOODS_PERCENT: 'درصدی از مبلغ کالا',
  FIXED: 'مبلغ ثابت هر ماموریت',
  UNSNAPSHOTTED: 'بدون ثبت مدل (ماموریت‌های قدیمی)',
};
const STATUS_LABELS: Record<string, string> = {
  PAID: 'رسید کالا در انتظار تأیید',
  ASSIGNED: 'کرایه در انتظار تأیید',
  AWAITING_PAYMENT: 'منتظر کارت‌به‌کارت',
  INVOICE_SENT: 'فاکتور در انتظار مشتری',
  SHOPPING: 'در حال خرید',
};

const fa = (value: number) => new Intl.NumberFormat('fa-IR').format(value);
const money = (value: string | number | null | undefined) => {
  const text = String(value ?? '0').trim();
  if (!/^\d+$/.test(text)) return '۰';
  return new Intl.NumberFormat('fa-IR').format(Number(text));
};
const when = (value: string | null) => value
  ? new Intl.DateTimeFormat('fa-IR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value))
  : '—';
const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

/** Stage four: the money side of the grocery phase, plus the receipts that still need a human. */
export function AdminGroceryReports({ token }: { token: string }) {
  const [from, setFrom] = useState(() => daysAgo(29));
  const [to, setTo] = useState(() => today());
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async (start = from, end = to) => {
    setLoading(true); setError('');
    try {
      const response = await fetch(`/api/v1/admin/grocery/reports?from=${encodeURIComponent(start)}&to=${encodeURIComponent(end)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error((payload as { message?: string } | null)?.message || 'گزارش نیامد.');
      setReport(payload as Report);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [from, to, token]);

  useEffect(() => { void load(); }, [load]);

  const preset = (days: number) => {
    const start = daysAgo(days - 1);
    const end = today();
    setFrom(start); setTo(end);
    void load(start, end);
  };

  const download = async () => {
    setBusy(true); setError(''); setNotice('');
    try {
      const response = await fetch(`/api/v1/admin/grocery/reports.csv?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error((payload as { message?: string } | null)?.message || 'فایل CSV ساخته نشد.');
      }
      const disposition = response.headers.get('content-disposition') ?? '';
      const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? `jetino-grocery-${from}_${to}.csv`;
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = url; link.download = filename;
      document.body.appendChild(link); link.click(); link.remove();
      URL.revokeObjectURL(url);
      setNotice('فایل CSV همین بازه دانلود شد.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const totals = report?.totals ?? {};
  const attention = report?.attention ?? {};
  const attentionRows = useMemo(() => ([
    ['goodsReceiptWaiting', 'رسید کالا منتظر تأیید پیک', 'PAID'],
    ['goodsReceiptStale', 'رسید کالا بیشتر از ۶ ساعت منتظر مانده', 'PAID'],
    ['feeReceiptWaiting', 'رسید کرایه منتظر تأیید پشتیبانی', 'ASSIGNED'],
    ['invoiceStale', 'فاکتور بیشتر از ۲۴ ساعت بدون جواب مشتری', 'INVOICE_SENT'],
    ['deliveredWithoutPayment', 'تحویل‌شده ولی پرداخت تأیید نشده', 'DELIVERED'],
    ['refundMissing', 'لغو با کرایهٔ تأییدشده ولی بدون ثبت استرداد', 'CANCELLED'],
    ['goodsConfirmedWithoutReceipt', 'پرداخت تأییدشده بدون عکس رسید', '—'],
  ] as Array<[string, string, string]>), []);

  const nonZeroAttention = attentionRows.filter(([key]) => Number(attention[key] ?? 0) > 0).length;

  return <section className="admin-card report-card" id="grocery-reports">
    <div className="queue-heading">
      <div>
        <span className="setting-icon"><BarChart3 size={18}/></span>
        <div><h2>گزارش سوپرمارکت</h2><small>کرایه، مبلغ کالا، کارمزد جتینو و رسیدهایی که هنوز رسیدگی نشده‌اند</small></div>
      </div>
      <button className="refresh-button" disabled={loading} onClick={() => void load()}>
        <RefreshCw size={14}/>{loading ? 'دارم می‌گیرم…' : 'به‌روزرسانی'}
      </button>
    </div>

    <div className="report-range">
      <span className="report-range-icon"><CalendarDays size={15}/></span>
      <label className="report-date">از
        <input className="admin-input ltr-input" type="date" dir="ltr" value={from} max={to}
          onChange={e => setFrom(e.target.value)} onBlur={() => void load()}/>
      </label>
      <label className="report-date">تا
        <input className="admin-input ltr-input" type="date" dir="ltr" value={to} min={from} max={today()}
          onChange={e => setTo(e.target.value)} onBlur={() => void load()}/>
      </label>
      <div className="report-presets">
        <button className="text-button" disabled={loading} onClick={() => preset(7)}>۷ روز</button>
        <button className="text-button" disabled={loading} onClick={() => preset(30)}>۳۰ روز</button>
        <button className="text-button" disabled={loading} onClick={() => preset(90)}>۹۰ روز</button>
      </div>
      <button className="primary-button report-csv" disabled={busy} onClick={() => void download()}>
        <Download size={15}/>{busy ? 'دارم می‌سازم…' : 'گرفتن CSV'}
      </button>
    </div>

    {error && <div className="feedback error" role="alert">{error}</div>}
    {notice && <div className="feedback success">{notice}</div>}

    {report && <>
      <p className="report-note">
        بازهٔ {report.from} تا {report.to} ({fa(report.days)} روز) · {fa(Number(totals.lists ?? 0))} لیست ثبت شده،
        {' '}{fa(Number(totals.delivered ?? 0))} تحویل‌شده و {fa(Number(totals.cancelled ?? 0))} لغوشده.
      </p>

      <div className="report-kpis">
        <div className="report-kpi">
          <small>کارمزد جتینو</small>
          <b>{money(totals.platformRial)} ریال</b>
          <i>از {fa(Number(totals.goodsConfirmedCount ?? 0))} پرداخت تأییدشده</i>
        </div>
        <div className="report-kpi">
          <small>کرایهٔ تأییدشده</small>
          <b>{money(totals.feesConfirmedRial)} ریال</b>
          <i>{fa(Number(totals.feesConfirmedCount ?? 0))} ماموریت · {money(totals.feesPendingRial)} ریال هنوز تأیید نشده</i>
        </div>
        <div className="report-kpi">
          <small>مبلغ کالای وصول‌شده</small>
          <b>{money(totals.goodsConfirmedRial)} ریال</b>
          <i>فقط پرداخت‌های تأییدشدهٔ پیک</i>
        </div>
        <div className="report-kpi">
          <small>استرداد به کیف پول</small>
          <b>{money(totals.refundedRial)} ریال</b>
          <i>{fa(Number(totals.refundedCount ?? 0))} ماموریت لغوشده</i>
        </div>
      </div>

      <h3 className="report-title"><Wallet size={16}/> کارمزد به‌تفکیک مدل درآمد</h3>
      {report.byModel.length === 0
        ? <p className="grocery-hint">در این بازه هیچ پرداختی تأیید نشده که کارمزد داشته باشد.</p>
        : <div className="report-table-wrap">
          <table className="report-table">
            <thead><tr><th>مدل</th><th>ماموریت</th><th>کرایه</th><th>مبلغ کالا</th><th>کارمزد</th></tr></thead>
            <tbody>{report.byModel.map(row => <tr key={row.mode}>
              <td data-label="مدل">{MODEL_LABELS[row.mode] ?? row.mode}</td>
              <td data-label="ماموریت">{fa(Number(row.lists))}</td>
              <td data-label="کرایه">{money(row.feesRial)}</td>
              <td data-label="مبلغ کالا">{money(row.goodsRial)}</td>
              <td data-label="کارمزد"><b>{money(row.platformRial)}</b></td>
            </tr>)}</tbody>
          </table>
        </div>}

      <h3 className="report-title"><AlertTriangle size={16}/> نیازمند رسیدگی
        <span className={`status-pill ${nonZeroAttention ? 'pending-pill' : 'status-confirmed'}`}>
          {nonZeroAttention ? `${fa(nonZeroAttention)} مورد` : 'همه‌چیز مرتبه'}
        </span>
      </h3>
      <div className="report-attention">
        {attentionRows.map(([key, label]) => {
          const value = Number(attention[key] ?? 0);
          return <div className={`report-attention-row${value > 0 ? ' warn' : ''}`} key={key}>
            <span>{label}</span><b>{fa(value)}</b>
          </div>;
        })}
      </div>

      {report.queue.length > 0 && <>
        <h3 className="report-title">رسیدهای در صف ({fa(report.queue.length)})</h3>
        <div className="report-queue">
          {report.queue.map(row => <div className="report-queue-row" key={row.id}>
            <div className="report-queue-main">
              <b>{row.storeName ?? 'فروشگاه آزاد'}</b>
              <small>
                {money(row.status === 'PAID' ? row.invoiceAmountRial : row.feeRial)} ریال ·
                {' '}مشتری <span dir="ltr">{row.customerPhone ?? '—'}</span> ·
                {' '}{when(row.paymentDeclaredAt ?? row.feeDeclaredAt)}
              </small>
            </div>
            <div className="report-queue-side">
              <span className={`status-pill ${row.status === 'PAID' ? 'pending-pill' : 'status-preparing'}`}>
                {STATUS_LABELS[row.status] ?? row.status}
              </span>
              {row.paymentReceiptUrl
                ? <a className="text-button" href={row.paymentReceiptUrl} target="_blank" rel="noreferrer">دیدن رسید</a>
                : <span className="report-queue-missing">بدون عکس</span>}
            </div>
          </div>)}
        </div>
      </>}

      {report.daily.length > 0 && <details className="report-daily">
        <summary>روز به روز ({fa(report.daily.length)} روز)</summary>
        <div className="report-table-wrap">
          <table className="report-table">
            <thead><tr><th>روز</th><th>لیست</th><th>پرداخت تأییدشده</th><th>کرایه</th><th>کالا</th><th>کارمزد</th></tr></thead>
            <tbody>{report.daily.slice(0, 31).map(row => <tr key={row.day}>
              <td data-label="روز" dir="ltr">{row.day}</td>
              <td data-label="لیست">{fa(Number(row.lists))}</td>
              <td data-label="پرداخت تأییدشده">{fa(Number(row.delivered))}</td>
              <td data-label="کرایه">{money(row.feesRial)}</td>
              <td data-label="کالا">{money(row.goodsRial)}</td>
              <td data-label="کارمزد"><b>{money(row.platformRial)}</b></td>
            </tr>)}</tbody>
          </table>
        </div>
      </details>}
    </>}

    {loading && !report && <SkeletonTable rows={4} cols={5} label="دارم گزارش رو حساب می‌کنم…"/>}
  </section>;
}
