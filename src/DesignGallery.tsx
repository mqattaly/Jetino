import { useState } from 'react';
import {
  ArrowLeft, Bell, Bike, ChefHat, Clock3, Coffee, Fish, MapPin, Moon, Plus, Search, ShieldCheck,
  ShoppingBag, Sparkles, Store, Sun, Truck, Utensils, Wallet,
} from 'lucide-react';
import { ActionButton, StatTile, TileButton } from './ui/controls';
import { ThemePicker, useTheme } from './ui/theme';

const palette = [
  ['مشکی نیمه‌شب', '#0a1420', 'پس‌زمینهٔ تیره'],
  ['سطح شب', '#0f1f30', 'کارت‌های تیره'],
  ['زرشکی', '#c9243f', 'رنگ اصلی'],
  ['آبی', '#1fa9e5', 'لهجهٔ آسمان'],
  ['فیروزه‌ای', '#1fc9b0', 'لهجهٔ دریا'],
  ['نارنجی', '#ec6c22', 'گرمای غذا'],
  ['ارغوانی', '#b8328f', 'لهجهٔ شب'],
  ['سفید صدفی', '#f2f6fb', 'پس‌زمینهٔ روشن'],
] as const;

export default function DesignGallery() {
  const { mode, accent } = useTheme();
  const [activeTile, setActiveTile] = useState('food');
  return <div className="gallery" dir="rtl">
    <header className="gallery-head">
      <div className="eyebrow muted">جتینو · سیستم طراحی</div>
      <h1>شب روشن؛ یک رابط ایکونیک</h1>
      <p>
        هر کلید یک آیکون و یک واژه دارد، هر سطح از یک پالت می‌آید و هر حرکت با اشارهٔ کاربر پاسخ می‌دهد.
        تم فعلی: <b>{mode === 'auto' ? 'خودکار' : mode === 'dark' ? 'تیره' : 'روشن'}</b> · رنگ اصلی: <b>{accent}</b>.
        این صفحه همان کامپوننت‌هایی را نشان می‌دهد که در فروشگاه، پیگیری سفارش، پنل پیک و پنل مدیریت استفاده می‌شوند.
      </p>
    </header>

    <section className="gallery-section">
      <h2><Sparkles size={16} />تم و رنگ</h2>
      <ThemePicker />
    </section>

    <section className="gallery-section">
      <h2><Bike size={16} />قهرمان فروشگاه</h2>
      <div className="gallery-hero">
        <img src="/images/hero-night.jpg" alt="تصویر شب بندر خمیر با پیک و ماه" />
        <div>
          <h2>طعم خوب، نزدیکِ خانه‌ی تو</h2>
          <p>سفارش غذای محلی، پیگیری زنده، پرداخت نقدی هنگام تحویل.</p>
        </div>
      </div>
    </section>

    <section className="gallery-section">
      <h2><ArrowLeft size={16} />کلیدها</h2>
      <div className="gallery-row">
        <ActionButton icon={ShoppingBag}>افزودن به سبد</ActionButton>
        <ActionButton icon={MapPin} variant="ghost">مسیر روی نقشه</ActionButton>
        <ActionButton icon={ShieldCheck} variant="danger">درخواست کمک فوری</ActionButton>
        <ActionButton icon={Clock3} variant="ghost" size="sm">به‌روزرسانی</ActionButton>
        <ActionButton icon={Truck} size="lg">ثبت تحویل با کد</ActionButton>
        <ActionButton icon={Plus} disabled>ناموجود</ActionButton>
      </div>
      <div className="gallery-tiles">
        <TileButton icon={Utensils} active={activeTile === 'food'} onClick={() => setActiveTile('food')}>غذا</TileButton>
        <TileButton icon={Coffee} active={activeTile === 'drink'} onClick={() => setActiveTile('drink')}>نوشیدنی</TileButton>
        <TileButton icon={Fish} active={activeTile === 'sea'} onClick={() => setActiveTile('sea')}>دریایی</TileButton>
        <TileButton icon={ChefHat} active={activeTile === 'local'} onClick={() => setActiveTile('local')}>محلی</TileButton>
        <TileButton icon={Wallet} active={activeTile === 'wallet'} onClick={() => setActiveTile('wallet')}>کیف پول</TileButton>
      </div>
    </section>

    <section className="gallery-section">
      <h2><Store size={16} />فیلترها و برچسب‌ها</h2>
      <div className="categories">
        {['همه', 'دریایی', 'کباب', 'قیمه', 'قنادی'].map((label, index) => <button key={label} className={index === 0 ? 'chosen' : ''}>{index === 0 ? <Sparkles size={13} /> : null}{label}</button>)}
      </div>
      <div className="gallery-row">
        {['در مسیر', 'در انتظار تأیید', 'تحویل‌شده', 'لغو‌شده'].map((label, index) => <span key={label} className={`status-pill ${['', 'pending-pill', 'verified-pill', 'error-pill'][index]}`}>{label}</span>)}
        <span className="chip"><ShieldCheck size={13} />مدارک تأییدشده</span>
        <span className="chip"><Clock3 size={13} />۳۰ دقیقه</span>
      </div>
      <div className="gallery-row">
        <label className="searchbox" style={{ maxWidth: 360, height: 50, padding: '0 16px' }}>
          <Search size={18} /><input placeholder="جست‌وجوی رستوران یا غذا" aria-label="نمونهٔ جست‌وجو" />
        </label>
        <label className="checkout-label" style={{ display: 'grid', gap: 6 }}>
          شمارهٔ موبایل
          <input className="checkout-input" placeholder="۰۹۱۲۳۴۵۶۷۸۹" inputMode="tel" />
        </label>
      </div>
    </section>

    <section className="gallery-section">
      <h2><Bell size={16} />اعداد و کارت‌ها</h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
        <StatTile label="سفارش امروز" value="۱۲" hint="۳ در مسیر" />
        <StatTile label="وجه نقد در جریان" value="۴٫۲ م" tone="warn" hint="۲ وصول" />
        <StatTile label="پیک فعال" value="۳" tone="teal" hint="همه تأییدشده" />
        <StatTile label="میانگین تحویل" value="۲۸ د" tone="neutral" hint="۷ روز اخیر" />
      </div>
      <article className="ops-order" style={{ maxWidth: 420 }}>
        <div className="ops-order-top"><div><span className="status-pill status-ready">آمادهٔ تحویل</span><small>۲۳:۴۰</small></div><b>۲۹۵٬۰۰۰ ریال</b></div>
        <div className="ops-order-info">
          <span>سفارش <b dir="ltr">A1B2C3D4</b></span>
          <span>پیک <b>رضا احمدی · 12ب34567</b></span>
        </div>
        <div className="ops-order-actions">
          <ActionButton icon={Truck} size="sm">شروع مسیر</ActionButton>
          <ActionButton icon={Moon} size="sm" variant="ghost">جزئیات</ActionButton>
        </div>
      </article>
    </section>

    <section className="gallery-section">
      <h2><Sun size={16} />پالت</h2>
      <div className="gallery-palette">
        {palette.map(([name, hex, role]) => <div className="palette-card" key={hex}>
          <span className="palette-chip" style={{ background: hex, boxShadow: hex === '#f2f6fb' ? 'inset 0 0 0 1px rgba(12,26,41,.15)' : undefined }} />
          <b>{name}</b>
          <small dir="ltr">{hex}</small>
          <small>{role}</small>
        </div>)}
      </div>
    </section>

    <p className="gallery-foot">این صفحه برای بازبینی ظاهر است؛ <a href="/">بازگشت به فروشگاه</a> · <a href="/orders">پیگیری سفارش</a> · <a href="/driver/deliveries">پنل پیک</a> · <a href="/admin/settings">مدیریت</a></p>
  </div>;
}
