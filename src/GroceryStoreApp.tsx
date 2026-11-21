import { useCallback, useEffect, useState } from 'react';
import { SkeletonList } from './ui/motion';
import {
  BadgeCheck, CircleAlert, ClipboardList, Clock3, Package, Pencil, Plus, RefreshCw, Save, ShoppingBasket, Store, Trash2, X,
} from 'lucide-react';
import { OtpLogin } from './OperationsApp';
import { BackButton } from './ui/controls';
import { PhotoField } from './PhotoField';
import { toPersianDigits } from './ui/plate';

type StoreRow = {
  id: string; name: string; phone: string | null; addressText: string; note: string | null;
  status: string; createdAt: string; approvedAt: string | null; regionName: string;
};
type Product = {
  id: string; name: string; category: string | null; unit: string; priceRial: string; stock: string;
  imageUrl: string | null; isActive: boolean; updatedAt: string;
};
type ShopProfile = { name: string; phone: string; addressText: string; note: string };
type ProductForm = { id: string; name: string; category: string; unit: string; priceRial: string; stock: string; imageUrl: string | null; isActive: boolean };

const TOKEN_KEY = 'jetino_grocery_store_token';
const UNITS = ['عدد', 'کیلوگرم', 'گرم', 'بسته', 'شانه', 'لیتر', 'بطری', 'قوطی', 'متر'];
const CATEGORIES = ['لبنیات', 'نان و شیرینی', 'میوه و سبزی', 'گوشت و مرغ', 'نوشیدنی', 'تنقلات', 'کنسرو و خشکار', 'شوینده', 'بهداشتی', 'لوازم خانه'];
const EMPTY_PRODUCT: ProductForm = { id: '', name: '', category: '', unit: 'عدد', priceRial: '', stock: '', imageUrl: null, isActive: true };

const fa = (value: string | number) => new Intl.NumberFormat('fa-IR').format(Number(value));
const money = (value: string | number | null) => value === null || value === undefined || value === '' ? '—' : `${fa(value)} ریال`;
const ascii = (value: string) => value.replace(/[۰-۹]/g, d => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d))).replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
const faDigits = (value: string | number) => toPersianDigits(String(value));

const STATUS: Record<string, { label: string; tone: string; line: string }> = {
  PENDING: { label: 'در انتظار تأیید', tone: 'pending', line: 'فروشگاهت ثبت شد و نشسته تو صف بررسی. می‌تونی از همین حالا قفسه‌ت رو بچینی؛ به‌محض تأیید، مشتری‌ها فروشگاهت رو می‌بینن.' },
  ACTIVE: { label: 'فعال', tone: 'active', line: 'فروشگاهت تأیید شده و مشتری‌های بندر خمیر می‌تونن موقع نوشتن لیست، تو رو انتخاب کنن.' },
  SUSPENDED: { label: 'معلق', tone: 'suspended', line: 'فروشگاهت موقتاً از دسترس مشتری‌ها خارج شده. برای پیگیری با پشتیبانی جتینو تماس بگیر.' },
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

/** Where a Khamir shop keeps its shelf: request the shop, wait for staff, then write the catalogue. */
export default function GroceryStoreApp() {
  const [token, setToken] = useState(() => sessionStorage.getItem(TOKEN_KEY) || '');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [store, setStore] = useState<StoreRow | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [profile, setProfile] = useState<ShopProfile>({ name: '', phone: '', addressText: '', note: '' });
  const [editingProfile, setEditingProfile] = useState(false);
  const [product, setProduct] = useState<ProductForm>(EMPTY_PRODUCT);
  const [formOpen, setFormOpen] = useState(false);

  const apply = useCallback((data: { store: StoreRow | null; products: Product[] }) => {
    setStore(data.store);
    setProducts(data.products ?? []);
    if (data.store) setProfile({ name: data.store.name, phone: data.store.phone ?? '', addressText: data.store.addressText, note: data.store.note ?? '' });
  }, []);

  const load = useCallback(async (auth = token) => {
    if (!auth) return;
    setLoading(true);
    try { apply(await request<{ store: StoreRow | null; products: Product[] }>('/api/v1/grocery/store/mine', auth)); }
    catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }, [token, apply]);

  useEffect(() => {
    document.title = 'پنل فروشگاه | سوپرمارکت جتینو';
    if (token) void load(token);
  }, [token, load]);

  const login = (auth: string) => { sessionStorage.setItem(TOKEN_KEY, auth); setToken(auth); setError(''); };
  const logout = () => { sessionStorage.removeItem(TOKEN_KEY); setToken(''); setStore(null); setProducts([]); };

  const run = async (action: () => Promise<void>, message?: string) => {
    setBusy(true); setError(''); setNotice('');
    try { await action(); if (message) setNotice(message); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  const saveProfile = () => run(async () => {
    const data = await request<{ store: StoreRow | null; products: Product[] }>('/api/v1/grocery/store/mine', token, {
      method: 'POST', body: JSON.stringify({ name: profile.name, phone: profile.phone || undefined, addressText: profile.addressText, note: profile.note || undefined }),
    });
    apply(data);
    setEditingProfile(false);
    setNotice(store ? 'اطلاعات فروشگاهت به‌روز شد.' : 'فروشگاهت ثبت شد؛ بعد از تأیید مدیر، مشتری‌ها می‌بیننش.');
  });

  const submitProduct = () => run(async () => {
    const body = {
      name: product.name,
      category: product.category || null,
      unit: product.unit,
      priceRial: ascii(product.priceRial),
      stock: ascii(product.stock || '0'),
      imageUrl: product.imageUrl,
      ...(product.id ? { isActive: product.isActive } : {}),
    };
    const data = await request<{ store: StoreRow | null; products: Product[] }>(
      product.id ? `/api/v1/grocery/store/mine/products/${product.id}` : '/api/v1/grocery/store/mine/products',
      token,
      { method: product.id ? 'PATCH' : 'POST', body: JSON.stringify(body) },
    );
    apply(data);
    setProduct(EMPTY_PRODUCT);
    setFormOpen(false);
    setNotice(product.id ? 'کالا به‌روز شد.' : 'کالا رفت روی قفسه.');
  });

  const archive = (item: Product) => run(async () => {
    if (!window.confirm(`«${item.name}» از قفسه برداشته بشه؟ مشتری دیگه نمی‌بینش، ولی فاکتورهای قبلی سالم می‌مونن.`)) return;
    apply(await request<{ store: StoreRow | null; products: Product[] }>(`/api/v1/grocery/store/mine/products/${item.id}`, token, { method: 'DELETE' }));
    setNotice('کالا از قفسه برداشته شد.');
  });

  const startEdit = (item: Product) => {
    setProduct({
      id: item.id, name: item.name, category: item.category ?? '', unit: item.unit,
      priceRial: faDigits(item.priceRial), stock: faDigits(Number(item.stock)), imageUrl: item.imageUrl, isActive: item.isActive,
    });
    setFormOpen(true);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const activeCount = products.filter(item => item.isActive).length;
  const outOfStock = products.filter(item => item.isActive && Number(item.stock) === 0).length;
  const status = store ? STATUS[store.status] ?? { label: store.status, tone: 'pending', line: '' } : null;
  const canEdit = !store || store.status !== 'SUSPENDED';

  return <div className="ops-page store-page" dir="rtl">
    <header className="ops-header">
      <a href="/grocery" className="brand"><span className="brand-mark">ج</span><span>جتینو<small>پنل فروشگاه</small></span></a>
      <div className="ops-header-actions">
        <a className="text-button" href="/grocery">خرید خونه</a>
        {token && <button className="logout-button" onClick={logout}>خروج</button>}
        <button className="refresh-button" disabled={busy || loading} onClick={() => void load()}>
          <RefreshCw size={14} />به‌روزرسانی
        </button>
      </div>
    </header>

    <main className="ops-main">
      <BackButton />
      <div className="ops-title">
        <div>
          <div className="eyebrow muted">قفسه‌ت رو خودت بچین</div>
          <h1>فروشگاه من</h1>
          <p>فروشگاهت رو ثبت کن، بعد از تأیید جتینو کالاهات رو با قیمت و موجودی بذار روی قفسه تا مشتری‌ها موقع نوشتن لیست انتخابش کنن.</p>
        </div>
      </div>

      {!token && <OtpLogin onSuccess={(auth: string) => login(auth)} onError={setError} />}

      {token && <>
        {error && <div className="grocery-alert error" role="alert">{error}</div>}
        {notice && <div className="grocery-alert ok" role="status">{notice}</div>}

        {!store && <section className="grocery-card">
          <h2><Store size={18} />ثبت فروشگاه</h2>
          <p className="grocery-hint">نام و نشانی رو دقیق بنویس؛ پیک با همین نشانی می‌آد سراغت. شمارهٔ فروشگاه هم برای هماهنگی خرید استفاده می‌شه.</p>
          <div className="grocery-grid-2">
            <label className="checkout-label">نام فروشگاه<input className="checkout-input" value={profile.name} maxLength={160}
              placeholder="مثلاً هایپر مرکزی" onChange={e => setProfile({ ...profile, name: e.target.value })} /></label>
            <label className="checkout-label">شمارهٔ تماس فروشگاه<input className="checkout-input" inputMode="tel" dir="ltr" value={profile.phone}
              placeholder="07630000000" onChange={e => setProfile({ ...profile, phone: ascii(e.target.value) })} /></label>
          </div>
          <label className="checkout-label">نشانی فروشگاه<input className="checkout-input" value={profile.addressText} maxLength={300}
            placeholder="بندر خمیر، خیابان امام، جنب مسجد جامع" onChange={e => setProfile({ ...profile, addressText: e.target.value })} /></label>
          <label className="checkout-label">توضیح برای پیک (اختیاری)<input className="checkout-input" value={profile.note} maxLength={300}
            placeholder="مثلاً ورودی از کوچهٔ پشتی" onChange={e => setProfile({ ...profile, note: e.target.value })} /></label>
          <button type="button" className="btn btn-primary" disabled={busy || profile.name.trim().length < 2 || profile.addressText.trim().length < 5} onClick={() => void saveProfile()}>
            <Save size={16} /><span>{busy ? 'دارم ثبت می‌کنم…' : 'ثبت فروشگاه'}</span>
          </button>
        </section>}

        {store && status && <>
          <section className={`store-banner ${status.tone}`}>
            <div className="store-banner-head">
              <span className="store-banner-icon">{store.status === 'ACTIVE' ? <BadgeCheck size={20} /> : store.status === 'SUSPENDED' ? <CircleAlert size={20} /> : <Clock3 size={20} />}</span>
              <div>
                <b>{store.name}</b>
                <small>{status.label} · {store.regionName}</small>
              </div>
            </div>
            <p>{status.line}</p>
            <div className="store-banner-stats">
              <span><Package size={14} />{fa(activeCount)} کالای فعال</span>
              <span className={outOfStock > 0 ? 'warn' : ''}><CircleAlert size={14} />{outOfStock > 0 ? `${fa(outOfStock)} کالا تموم شده` : 'همه‌چیز موجوده'}</span>
            </div>
          </section>

          <section className="grocery-card">
            <div className="store-card-head">
              <h2><Store size={18} />اطلاعات فروشگاه</h2>
              {!editingProfile && canEdit && <button type="button" className="text-button" onClick={() => setEditingProfile(true)}><Pencil size={14} />ویرایش</button>}
            </div>
            {editingProfile ? <>
              <div className="grocery-grid-2">
                <label className="checkout-label">نام فروشگاه<input className="checkout-input" value={profile.name} maxLength={160} onChange={e => setProfile({ ...profile, name: e.target.value })} /></label>
                <label className="checkout-label">شمارهٔ تماس<input className="checkout-input" inputMode="tel" dir="ltr" value={profile.phone} onChange={e => setProfile({ ...profile, phone: ascii(e.target.value) })} /></label>
              </div>
              <label className="checkout-label">نشانی<input className="checkout-input" value={profile.addressText} maxLength={300} onChange={e => setProfile({ ...profile, addressText: e.target.value })} /></label>
              <label className="checkout-label">توضیح برای پیک<input className="checkout-input" value={profile.note} maxLength={300} onChange={e => setProfile({ ...profile, note: e.target.value })} /></label>
              <div className="store-form-actions">
                <button type="button" className="btn btn-primary" disabled={busy || profile.name.trim().length < 2 || profile.addressText.trim().length < 5} onClick={() => void saveProfile()}>
                  <Save size={16} /><span>ذخیره</span>
                </button>
                <button type="button" className="text-button" onClick={() => { setEditingProfile(false); setProfile({ name: store.name, phone: store.phone ?? '', addressText: store.addressText, note: store.note ?? '' }); }}>بی‌خیال</button>
              </div>
            </> : <dl className="store-facts">
              <div><dt>نشانی</dt><dd>{store.addressText}</dd></div>
              <div><dt>تلفن</dt><dd dir="ltr">{store.phone ? faDigits(store.phone) : 'ثبت نشده'}</dd></div>
              <div><dt>منطقه</dt><dd>{store.regionName}</dd></div>
              {store.note && <div><dt>یادداشت</dt><dd>{store.note}</dd></div>}
            </dl>}
          </section>

          <section className="grocery-card">
            <div className="store-card-head">
              <h2><ShoppingBasket size={18} />قفسهٔ فروشگاه</h2>
              {canEdit && <button type="button" className="text-button" onClick={() => { setProduct(EMPTY_PRODUCT); setFormOpen(value => !value); }}>
                {formOpen ? <X size={14} /> : <Plus size={14} />}{formOpen ? 'بستن فرم' : 'کالای تازه'}
              </button>}
            </div>

            {formOpen && canEdit && <div className="store-product-form">
              <div className="grocery-grid-2">
                <label className="checkout-label">نام کالا<input className="checkout-input" value={product.name} maxLength={160}
                  placeholder="مثلاً سیب زرد" onChange={e => setProduct({ ...product, name: e.target.value })} /></label>
                <label className="checkout-label">دسته<input className="checkout-input" list="store-categories" value={product.category} maxLength={40}
                  placeholder="مثلاً میوه و سبزی" onChange={e => setProduct({ ...product, category: e.target.value })} />
                  <datalist id="store-categories">{CATEGORIES.map(item => <option key={item} value={item} />)}</datalist>
                </label>
              </div>
              <div className="store-product-row">
                <label className="checkout-label">واحد<select className="checkout-input" value={product.unit} onChange={e => setProduct({ ...product, unit: e.target.value })}>
                  {UNITS.map(unit => <option key={unit} value={unit}>{unit}</option>)}
                </select></label>
                <label className="checkout-label">قیمت هر واحد (ریال)<input className="checkout-input" inputMode="numeric" dir="ltr" value={product.priceRial}
                  placeholder="84000" onChange={e => setProduct({ ...product, priceRial: ascii(e.target.value).replace(/[^\d]/g, '') })} />
                  {product.priceRial && <small className="store-price-hint">{money(ascii(product.priceRial))}</small>}
                </label>
                <label className="checkout-label">موجودی<input className="checkout-input" inputMode="decimal" dir="ltr" value={product.stock}
                  placeholder="12" onChange={e => setProduct({ ...product, stock: ascii(e.target.value).replace(/[^\d.]/g, '') })} /></label>
              </div>
              <PhotoField label="عکس کالا (اختیاری)" hint="عکس تازه و واضح از خود کالا؛ مشتری همون رو می‌بینه." value={product.imageUrl}
                alt={product.name || 'عکس کالا'} disabled={busy} onChange={value => setProduct({ ...product, imageUrl: value })} />
              {product.id && <label className="store-toggle">
                <input type="checkbox" checked={product.isActive} onChange={e => setProduct({ ...product, isActive: e.target.checked })} />
                <span>کالا روی قفسه باشه</span>
              </label>}
              <div className="store-form-actions">
                <button type="button" className="btn btn-primary" disabled={busy || product.name.trim().length < 2 || !product.priceRial}
                  onClick={() => void submitProduct()}>
                  <Save size={16} /><span>{busy ? 'دارم ذخیره می‌کنم…' : product.id ? 'ذخیرهٔ تغییرات' : 'بذار روی قفسه'}</span>
                </button>
                <button type="button" className="text-button" onClick={() => { setProduct(EMPTY_PRODUCT); setFormOpen(false); }}>بی‌خیال</button>
              </div>
            </div>}

            {loading && products.length === 0
              ? <SkeletonList rows={3} label="در حال خواندن قفسه…"/>
              : products.length === 0
              ? <p className="grocery-empty">قفسه خالیه. اولین کالا رو اضافه کن تا مشتری‌ها ببیننش.</p>
              : <ul className="store-shelf">
                {products.map(item => <li key={item.id} className={`store-shelf-item${item.isActive ? '' : ' archived'}`}>
                  <span className="store-shelf-thumb">{item.imageUrl ? <img src={item.imageUrl} alt={item.name} loading="lazy" /> : <ShoppingBasket size={18} />}</span>
                  <div className="store-shelf-body">
                    <b>{item.name}</b>
                    <small>{item.category || 'بدون دسته'} · {item.unit} · {money(item.priceRial)}</small>
                    <small className={Number(item.stock) === 0 ? 'stock-out' : ''}>
                      {item.isActive ? (Number(item.stock) === 0 ? 'موجودی تموم شده' : `موجودی: ${fa(Number(item.stock))}`) : 'از قفسه برداشته شده'}
                    </small>
                  </div>
                  {canEdit && <div className="store-shelf-actions">
                    <button type="button" className="menu-edit" onClick={() => startEdit(item)}><Pencil size={14} />ویرایش</button>
                    {item.isActive && <button type="button" className="menu-edit danger" onClick={() => void archive(item)}><Trash2 size={14} />برداشتن</button>}
                  </div>}
                </li>)}
              </ul>}
          </section>

          <p className="grocery-hint"><ClipboardList size={13} /> قیمت‌ها فقط برای راهنمایی مشتری‌ست؛ پیک موقع خرید فاکتور فروشگاه رو می‌گیره و همون مبلغ نهایی حساب می‌شه.</p>
        </>}
      </>}
    </main>
  </div>;
}
