import { useCallback, useEffect, useState } from 'react';
import { BadgeCheck, CircleSlash, Clock3, RefreshCw, Store } from 'lucide-react';

type StoreRow = {
  id: string; name: string; phone: string | null; addressText: string; note: string | null; status: string;
  createdAt: string; approvedAt: string | null; regionName: string;
  ownerPhone: string | null; ownerName: string | null; productCount: number;
};

const FILTERS: Array<{ key: string; label: string }> = [
  { key: 'PENDING', label: 'در انتظار تأیید' },
  { key: 'ACTIVE', label: 'فعال' },
  { key: 'SUSPENDED', label: 'معلق' },
  { key: '', label: 'همه' },
];
const STATUS: Record<string, { label: string; cls: string }> = {
  PENDING: { label: 'در انتظار تأیید', cls: 'pending' },
  ACTIVE: { label: 'فعال', cls: 'active' },
  SUSPENDED: { label: 'معلق', cls: 'suspended' },
};
const fa = (value: number) => new Intl.NumberFormat('fa-IR').format(value);
const when = (value: string | null) => value
  ? new Intl.DateTimeFormat('fa-IR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value))
  : '—';

async function call<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error((payload as { message?: string } | null)?.message || 'درخواست ناموفق بود.');
  return payload as T;
}

/** Stage five: who is allowed to sell through the app, and who is not — yet. */
export function AdminGroceryStores({ token }: { token: string }) {
  const [filter, setFilter] = useState('PENDING');
  const [items, setItems] = useState<StoreRow[]>([]);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [notes, setNotes] = useState<Record<string, string>>({});

  const load = useCallback(async (status = filter) => {
    setError('');
    try {
      const query = status ? `?status=${status}` : '';
      const data = await call<{ items: StoreRow[] }>(`/api/v1/admin/grocery/stores${query}`, token);
      setItems(data.items ?? []);
    } catch (e) { setError((e as Error).message); }
  }, [token, filter]);

  useEffect(() => { void load(filter); }, [load, filter]);

  const decide = async (store: StoreRow, status: string) => {
    setBusy(store.id); setError(''); setNotice('');
    try {
      await call<{ items: StoreRow[] }>(`/api/v1/admin/grocery/stores/${store.id}/status`, token, {
        method: 'POST',
        body: JSON.stringify({ status, note: notes[store.id]?.trim() || undefined }),
      });
      await load(filter);
      setNotice(status === 'ACTIVE'
        ? `«${store.name}» تأیید شد و از الان تو لیست مشتری‌ها دیده می‌شه.`
        : status === 'SUSPENDED'
          ? `«${store.name}» معلق شد؛ صاحبش پیام می‌گیره.`
          : `«${store.name}» به صف بررسی برگشت.`);
      setNotes(current => ({ ...current, [store.id]: '' }));
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(''); }
  };

  return <section className="grocery-card admin-stores">
    <div className="store-card-head">
      <h2><Store size={18} />فروشگاه‌ها</h2>
      <button type="button" className="text-button" disabled={Boolean(busy)} onClick={() => void load(filter)}><RefreshCw size={14} />به‌روزرسانی</button>
    </div>
    <p className="grocery-hint">فقط فروشگاه «فعال» تو لیست خرید مشتری‌ها می‌آد. معلق یعنی صاحبش هنوز می‌تونه قفسه‌ش رو ببینه، ولی مشتری نه.</p>

    <div className="admin-stores-filters" role="tablist" aria-label="فیلتر وضعیت فروشگاه">
      {FILTERS.map(item => <button key={item.key || 'all'} type="button" role="tab" aria-selected={filter === item.key}
        className={`admin-stores-filter${filter === item.key ? ' on' : ''}`} onClick={() => setFilter(item.key)}>{item.label}</button>)}
    </div>

    {error && <div className="grocery-alert error" role="alert">{error}</div>}
    {notice && <div className="grocery-alert ok" role="status">{notice}</div>}

    {items.length === 0
      ? <p className="grocery-empty">توی این وضعیت فروشگاهی نیست.</p>
      : <ul className="admin-stores-list">
        {items.map(store => {
          const pill = STATUS[store.status] ?? { label: store.status, cls: '' };
          return <li key={store.id} className="admin-store-card">
            <div className="admin-store-head">
              <div>
                <b>{store.name}</b>
                <small className={`admin-store-pill ${pill.cls}`}>{store.status === 'PENDING' ? <Clock3 size={12} /> : store.status === 'ACTIVE' ? <BadgeCheck size={12} /> : <CircleSlash size={12} />}{pill.label}</small>
              </div>
              <small className="admin-store-meta">ثبت: {when(store.createdAt)} · {fa(store.productCount)} کالا</small>
            </div>
            <dl className="admin-store-facts">
              <div><dt>صاحب</dt><dd>{store.ownerName || 'بدون نام'} {store.ownerPhone ? <span dir="ltr">· {store.ownerPhone}</span> : null}</dd></div>
              <div><dt>تماس فروشگاه</dt><dd dir="ltr">{store.phone || '—'}</dd></div>
              <div><dt>نشانی</dt><dd>{store.addressText}</dd></div>
              <div><dt>منطقه</dt><dd>{store.regionName}</dd></div>
              {store.note && <div><dt>یادداشت</dt><dd>{store.note}</dd></div>}
            </dl>
            <div className="admin-store-actions">
              {store.status !== 'ACTIVE' && <button type="button" className="btn btn-primary admin-store-btn" disabled={Boolean(busy)}
                onClick={() => void decide(store, 'ACTIVE')}>{busy === store.id ? 'دارم ثبت می‌کنم…' : 'تأیید فروشگاه'}</button>}
              {store.status !== 'SUSPENDED' && <button type="button" className="text-button danger" disabled={Boolean(busy)}
                onClick={() => void decide(store, 'SUSPENDED')}>معلق کن</button>}
              {store.status !== 'PENDING' && <button type="button" className="text-button" disabled={Boolean(busy)}
                onClick={() => void decide(store, 'PENDING')}>برگردون به بررسی</button>}
            </div>
            <label className="admin-store-note">یادداشت برای صاحب فروشگاه (اختیاری)
              <input className="checkout-input" maxLength={300} value={notes[store.id] ?? ''}
                placeholder="مثلاً نشانی ناقصه؛ لطفاً دقیق بنویس"
                onChange={e => setNotes(current => ({ ...current, [store.id]: e.target.value }))} />
            </label>
          </li>;
        })}
      </ul>}
  </section>;
}
