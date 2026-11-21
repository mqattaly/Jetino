import { useCallback, useEffect, useState } from 'react';
import { Bell, BellRing, RefreshCw, Send, Smartphone } from 'lucide-react';
import { SkeletonList } from './ui/motion';

/**
 * §7.12 through the operations window: every notification the platform wrote, what the delivery
 * ledger says about the push channel, and the two actions an operator actually has — run the queue
 * now, or re-queue a row that failed while the phone was unreachable. Nothing here pretends a
 * send happened: a row with `SKIPPED` means the channel was off, and the reason is the stored error.
 */
type DeliveryStats = {
  push: { total: number; pending: number; sent: number; failed: number; skipped: number };
  inAppSent: number;
  subscriptions: { active: number; total: number };
  retryAfter: { attempts: number; failures: number };
  sender: { configured: boolean; vapidReady: boolean; subject: string; allowLocal: boolean };
};
type DeliveryRow = {
  id: string; notificationId: string; userId: string; channel: 'IN_APP' | 'PUSH'; state: string;
  attempts: number; nextAttemptAt: string; lastError: string | null; sentAt: string | null;
  eventType: string; title: string; phone: string;
};

const STATES = ['PENDING', 'SENT', 'FAILED', 'SKIPPED'] as const;
const stateLabel = (state: string) => ({ PENDING: 'در صف', SENT: 'ارسال شد', FAILED: 'ناموفق', SKIPPED: 'بدون ارسال' } as Record<string, string>)[state] || state;
const channelLabel = (channel: string) => (channel === 'PUSH' ? 'اعلان مرورگر' : 'داخل برنامه');
const fa = (value: number | string) => new Intl.NumberFormat('fa-IR').format(Number(value || 0));
const dateTime = (value: string | null) => (value ? new Intl.DateTimeFormat('fa-IR-u-ca-persian', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value)) : '—');
const tail = (phone: string) => phone.slice(-6);

async function requestJson<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init?.headers || {}) } });
  const data = ((await response.json().catch(() => ({}))) ?? {}) as T & { message?: string };
  if (!response.ok) throw new Error(typeof data.message === 'string' ? data.message : `خطا (${response.status})`);
  return data;
}

export function NotificationDeliveryBoard({ token }: { token: string }) {
  const [stats, setStats] = useState<DeliveryStats | null>(null);
  const [rows, setRows] = useState<DeliveryRow[]>([]);
  const [state, setState] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setBusy(true); setError('');
    try {
      const [counters, queue] = await Promise.all([
        requestJson<DeliveryStats>('/api/v1/notifications/delivery/stats', token),
        requestJson<{ items: DeliveryRow[] }>(`/api/v1/notifications/delivery/queue${state ? `?state=${state}` : ''}`, token),
      ]);
      setStats(counters); setRows(queue.items);
    } catch (cause) { setError((cause as Error).message); } finally { setBusy(false); }
  }, [token, state]);

  useEffect(() => { void load(); }, [load]);

  const runQueue = async () => {
    setBusy(true); setError(''); setNote('');
    try {
      const result = await requestJson<{ claimed: number; sent: number; failed: number; skipped: number; sender: string }>('/api/v1/notifications/dispatch', token, { method: 'POST', body: JSON.stringify({ limit: 50 }) });
      // the sender is reported because SKIPPED only means something when you know no transport was configured
      setNote(`ارسال ${fa(result.sent)} مورد از ${fa(result.claimed)} ردیف صف · کانال: ${result.sender === 'unconfigured' ? 'پیکربندی‌نشده' : result.sender === 'web-push' ? 'وب‌پوش' : 'آزمون'}`);
      await load();
    } catch (cause) { setError((cause as Error).message); } finally { setBusy(false); }
  };

  const retry = async (id: string) => {
    setBusy(true); setError(''); setNote('');
    try { await requestJson<{ retried: number }>(`/api/v1/notifications/delivery/${id}/retry`, token, { method: 'POST', body: '{}' }); setNote('ردیف دوباره در صف قرار گرفت.'); await load(); }
    catch (cause) { setError((cause as Error).message); } finally { setBusy(false); }
  };

  return (
    <section className="admin-card delivery-card">
      <div className="queue-heading">
        <div>
          <span className="setting-icon"><BellRing size={18}/></span>
          <div><h2>وضعیت ارسال اعلان‌ها</h2><small>دفتر ارسال · کنترل تکرار و هدفمندی رویداد</small></div>
        </div>
        <div className="report-controls">
          <select aria-label="فیلتر وضعیت ارسال" value={state} disabled={busy} onChange={(event) => setState(event.target.value)}>
            <option value="">همهٔ وضعیت‌ها</option>
            {STATES.map((option) => <option key={option} value={option}>{stateLabel(option)}</option>)}
          </select>
          <button className="refresh-button" disabled={busy} onClick={() => void load()}><RefreshCw size={14}/>{busy ? 'در حال بررسی…' : 'به‌روزرسانی'}</button>
          <button className="refresh-button" disabled={busy} onClick={() => void runQueue()}><Send size={14}/>اجرای صف</button>
        </div>
      </div>

      {error && <div className="feedback error" role="alert">{error}</div>}
      {note && <div className="feedback success">{note}</div>}

      {stats && <>
        <div className="report-grid">
          <div><small>ردیف اعلان مرورگر</small><b>{fa(stats.push.total)}</b></div>
          <div><small>در صف ارسال</small><b>{fa(stats.push.pending)}</b></div>
          <div><small>ارسال‌شده روی گوشی</small><b>{fa(stats.push.sent)}</b></div>
          <div><small>ناموفق</small><b>{fa(stats.push.failed)}</b><i>{fa(stats.push.skipped)} مورد بدون ارسال</i></div>
          <div><small>داخل برنامه خوانده‌شدنی</small><b>{fa(stats.inAppSent)}</b></div>
          <div><small>دستگاه‌های ثبت‌شده</small><b>{fa(stats.subscriptions.active)}</b><i>{fa(stats.subscriptions.total)} اشتراک در کل</i></div>
        </div>
        <div className="delivery-channel">
          <span className={stats.sender.configured ? 'delivery-flag on' : 'delivery-flag off'}>
            {stats.sender.configured ? <><Smartphone size={14}/>وب‌پوش فعال است · {stats.sender.subject}</> : <><Bell size={14}/>وب‌پوش پیکربندی نشده · ردیف‌ها SKIPPED می‌شوند</>}
          </span>
          <small>هر اعلان تا {fa(stats.retryAfter.attempts)} تلاش با فاصلهٔ فزاینده دوباره امتحان می‌شود؛ اشتراکی که سرویس آن را رد کند غیرفعال می‌شود.</small>
        </div>
      </>}

      {rows.length === 0 && busy ? <SkeletonList rows={4} label="در حال خواندن صف ارسال…"/> : rows.length === 0 ? <div className="queue-empty">ردیفی برای این فیلتر نیست. صف هر {fa(5)} دقیقه یک‌بار هم با زمان‌بند اجرا می‌شود.</div> : (
        <div className="delivery-rows">
          {rows.map((row) => (
            <div className={`delivery-row ${row.state.toLowerCase()}`} key={String(row.id)}>
              <div className="delivery-main">
                <b>{row.title}</b>
                <small>{tail(row.phone)} · {row.eventType} · {channelLabel(row.channel)}</small>
              </div>
              <div className="delivery-meta">
                <span className={`delivery-state ${row.state.toLowerCase()}`}>{stateLabel(row.state)}</span>
                <small>تلاش {fa(row.attempts)}{row.sentAt ? ` · ${dateTime(row.sentAt)}` : row.nextAttemptAt ? ` · تلاش بعد ${dateTime(row.nextAttemptAt)}` : ''}</small>
                {row.lastError && <code title={row.lastError}>{row.lastError}</code>}
              </div>
              {row.state === 'FAILED' && <button className="approve-button" disabled={busy} onClick={() => void retry(String(row.id))}><RefreshCw size={13}/>تلاش دوباره</button>}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
