import { useEffect, useMemo, useState } from 'react';
import { Search, MapPin, ShoppingBag, ChevronDown, Plus, Minus, X, ArrowLeft, Utensils, Bike, ShieldCheck, Clock3, Home, ClipboardList, Bell, Fish, ChefHat, Coffee, CakeSlice, Sparkles, Store, Wallet, ShoppingBasket } from 'lucide-react';
import CheckoutFlow, { OrderSuccess } from './CheckoutFlow';
import { SkeletonCards, SkeletonDishes } from './ui/motion';
import { GROCERY_FLOW_IMAGE, HERO_IMAGE, photoFor } from './catalogImages';

type Restaurant={id:string;name:string;description:string|null;regionName:string;regionSlug:string;deliveryFeeRial:string|null;categories:string[];accent:string;icon:string;time:string};
type Product={id:string;name:string;description:string|null;priceRial:string;imageUrl?:string|null};
type Category={id:string;name:string;products:Product[]};
type CartLine={productId:string;businessId:string;name:string;description:string|null;priceRial:string;quantity:number;icon:string;imageUrl?:string|null};
type OrderResult={id:string;status:string;payment:{method:string;status:string};amounts:{totalRial:string}};
const money=(v:string|number|bigint)=>new Intl.NumberFormat('fa-IR').format(BigInt(v))+' ریال';
const emojis=['🐟','🍲','🍕','🍢','☕','🥪'];const accents=['sea','orange','red','green','yellow','bakery'];
async function jsonRequest<T>(url:string):Promise<T>{const response=await fetch(url);if(!response.ok)throw new Error(`پاسخ سرویس ${response.status} بود`);return response.json() as Promise<T>;}
function App(){
 const [restaurants,setRestaurants]=useState<Restaurant[]>([]);const [loadError,setLoadError]=useState('');const [loading,setLoading]=useState(true);const [unreadNotifications,setUnreadNotifications]=useState(0);
 const [category,setCategory]=useState('همه');const [query,setQuery]=useState('');const [selected,setSelected]=useState<Restaurant|null>(null);
 const [menu,setMenu]=useState<Category[]>([]);const [menuLoading,setMenuLoading]=useState(false);const [menuError,setMenuError]=useState('');
 const [cart,setCart]=useState<Record<string,CartLine>>({});const [cartBusiness,setCartBusiness]=useState<string|null>(null);const [cartOpen,setCartOpen]=useState(false);const [checkoutOpen,setCheckoutOpen]=useState(false);const [cartMessage,setCartMessage]=useState('');const [order,setOrder]=useState<OrderResult|null>(null);
 useEffect(()=>{jsonRequest<Array<{id:string;name:string;description:string|null;region_name:string;region_slug:string;delivery_fee_rial:string|null;categories:string[]}>>('/api/v1/businesses?region=bandar-khamir').then(rows=>setRestaurants(rows.map((r,i)=>({id:r.id,name:r.name,description:r.description,regionName:r.region_name,regionSlug:r.region_slug,deliveryFeeRial:r.delivery_fee_rial,categories:r.categories||[],accent:accents[i%accents.length],icon:emojis[i%emojis.length],time:'زمان آماده‌سازی سفارش'})))).catch(e=>setLoadError((e as Error).message)).finally(()=>setLoading(false));},[]);
 useEffect(()=>{const refresh=()=>{const token=sessionStorage.getItem('jetino_customer_token');if(!token){setUnreadNotifications(0);return;}fetch('/api/v1/notifications',{headers:{Authorization:`Bearer ${token}`}}).then(r=>r.ok?r.json():null).then(data=>{if(data&&Number.isFinite(data.unreadCount))setUnreadNotifications(data.unreadCount);}).catch(()=>{});};refresh();window.addEventListener('focus',refresh);const timer=window.setInterval(refresh,60_000);return()=>{window.removeEventListener('focus',refresh);window.clearInterval(timer);};},[]);
 const categories=useMemo(()=>['همه',...new Set(restaurants.flatMap(r=>r.categories))],[restaurants]);
 const filtered=useMemo(()=>restaurants.filter(r=>(category==='همه'||r.categories.includes(category))&&(r.name+' '+(r.description||'')+' '+r.categories.join(' ')).toLocaleLowerCase().includes(query.toLocaleLowerCase())),[restaurants,category,query]);
 const lines=Object.values(cart);const count=lines.reduce((sum,item)=>sum+item.quantity,0);const subtotal=lines.reduce((sum,item)=>sum+BigInt(item.priceRial)*BigInt(item.quantity),0n);
 const openBusiness=async(r:Restaurant)=>{setSelected(r);setMenu([]);setMenuError('');setMenuLoading(true);try{const result=await jsonRequest<{categories:Category[]}>(`/api/v1/businesses/${r.id}`);setMenu(result.categories||[]);}catch(e){setMenuError((e as Error).message);}finally{setMenuLoading(false);}};
 const add=(product:Product,business:Restaurant)=>{setCartMessage('');if(cartBusiness&&cartBusiness!==business.id){setCartMessage('سبد خرید فقط می‌تواند از یک کسب‌وکار باشد؛ سبد فعلی را خالی کنید تا از اینجا سفارش دهید.');return;}setCartBusiness(business.id);setCart(current=>({...current,[product.id]:{productId:product.id,businessId:business.id,name:product.name,description:product.description,priceRial:String(product.priceRial),quantity:(current[product.id]?.quantity||0)+1,icon:business.icon,imageUrl:product.imageUrl??current[product.id]?.imageUrl??null}}));};
 const remove=(id:string)=>{const item=cart[id];if(!item)return;if(item.quantity<=1&&Object.keys(cart).length===1)setCartBusiness(null);setCart(current=>{const live=current[id];if(!live)return current;if(live.quantity<=1){const next={...current};delete next[id];return next;}return {...current,[id]:{...live,quantity:live.quantity-1}};});};
 const clearCart=()=>{setCart({});setCartBusiness(null);setCartMessage('');};
 const selectedCount=selected?Object.values(cart).filter(x=>x.businessId===selected.id).reduce((sum,x)=>sum+x.quantity,0):0;
 const checkout=()=>{setCartOpen(false);setCheckoutOpen(true);};
 return <div className="app-shell">
  <header className="topbar"><a className="brand" href="#top"><span className="brand-mark">ج</span><span>جتینو<small>محلی، راحت، نزدیک</small></span></a><div className="address"><MapPin size={17}/><span><small>محدودهٔ فعلی</small><b>بندر خمیر</b></span><ChevronDown size={15}/></div><nav><a className="active" href="#businesses"><Utensils size={15}/>غذا و خرید</a><a href="/grocery"><ShoppingBasket size={15}/>سوپرمارکت</a><a href="#how"><Sparkles size={15}/>چطور کار می‌کند؟</a><a href="/orders"><ClipboardList size={15}/>پیگیری سفارش</a><a href="/notifications" className="notification-nav-link"><Bell size={15}/>اعلان‌ها{unreadNotifications>0&&<i className="notification-nav-count">{unreadNotifications>99?'۹۹+':new Intl.NumberFormat('fa-IR').format(unreadNotifications)}</i>}</a><a href="/business/orders"><Store size={15}/>ورود کسب‌وکار</a></nav><button className="cart-top" onClick={()=>setCartOpen(true)}><ShoppingBag size={17}/><span>سبد خرید</span>{count>0&&<i>{count}</i>}</button></header>
  <main id="top"><section className="hero"><div className="hero-media"><img src={HERO_IMAGE.src} alt="" fetchPriority="high"/></div><div className="hero-copy"><div className="eyebrow"><span className="pulse"/> غذا و خرید روزانه در بندر خمیر</div>
      <h1>غذای داغ، سبد پر،<br/><em>یک پیک تا دمِ خونه</em></h1>
      <p>از رستوران‌های محلی غذا بگیر یا لیست خرید خونه رو به پیک بسپار. جتینو هم آشپزخونه‌های بندر خمیر رو می‌شناسه، هم سبد خریدتو از سوپرمارکت پر می‌کنه.</p>
      <label className="searchbox"><Search size={19}/><input aria-label="جست‌وجو در رستوران، غذا یا سوپرمارکت" value={query} onChange={e=>setQuery(e.target.value)} placeholder="اسم رستوران، غذا یا سوپرمارکت رو بنویس"/></label>
      <div className="hero-note"><span><ShieldCheck size={16}/> هویت پیک</span><span><Bike size={17}/> پیگیری زنده</span><span><ShoppingBasket size={16}/> لیست خرید</span><span><Wallet size={16}/> نقدی یا کارت‌به‌کارت</span></div>
    </div><div className="hero-art"><div className="sun"/><div className="plate"><span>🍽️</span></div><div className="food-tag tag-one">🍋 غذای داغ محلی</div><div className="food-tag tag-two">🛒 سبد خرید خونه</div><div className="art-wave"/></div><div className="hero-bottom"><span>از بندر خمیر، برای بندر خمیر</span><span>غذا یا خرید، هر دو <b>↓</b></span></div></section>
  <section className="quick-actions" aria-label="دسترسی سریع">
    <button type="button" className="tile-btn" onClick={()=>{document.getElementById('businesses')?.scrollIntoView({behavior:'smooth'});}}><Utensils size={22}/><span>منوی امروز</span></button>
    <button type="button" className="tile-btn grocery-tile" onClick={()=>{window.location.href='/grocery';}}><ShoppingBasket size={22}/><span>خرید خونه</span></button>
    <button type="button" className="tile-btn" onClick={()=>{window.location.href='/orders';}}><ClipboardList size={22}/><span>پیگیری سفارش</span></button>
    <button type="button" className="tile-btn" onClick={()=>{window.location.href='/join/driver';}}><Bike size={22}/><span>پیک شو</span></button>
</section>
  <section className="trust-strip">
    <div><strong>محلی و نزدیک</strong><span>رستوران‌ها و سوپرمارکت‌های شهر</span></div>
    <div><strong>غذا و خرید</strong><span>یک اپ، دو سرویس</span></div>
    <div><strong>شفاف و ساده</strong><span>هزینه‌ها رو از قبل می‌بینی</span></div>
    <div><strong>پرداخت دلخواه</strong><span>نقدی یا کارت‌به‌کارت</span></div>
    <span className="strip-icon">✳</span>
  </section>

  <section id="grocery" className="grocery-band" aria-labelledby="grocery-title">
    <div className="grocery-band-copy">
      <div className="eyebrow"><ShoppingBasket size={14}/> سوپرمارکت با جتینو</div>
      <h2 id="grocery-title">لیست بنویس،<br/><em>پیک خرید رو میاره</em></h2>
      <p>لازم نیست از خونه بیرون بزنی. لیست خریدتو می‌نویسی، پیک‌های محلی قیمت ماموریت می‌دن و بعد از پرداخت کرایه، خرید انجام می‌شه و دمِ در تحویلش می‌گیری.</p>
      <ol className="grocery-band-steps">
        <li><b>۱</b><span>لیست رو بنویس</span><small>«۲ کیلو سیب، نان، ماست و…»</small></li>
        <li><b>۲</b><span>پیشنهاد پیک رو ببین</span><small>قیمت ماموریت شفافه و خودت انتخاب می‌کنی</small></li>
        <li><b>۳</b><span>فاکتور و تحویل</span><small>فاکتور رو تأیید می‌کنی، حساب می‌کنی و زنده پیگیری می‌کنی</small></li>
      </ol>
      <div className="grocery-band-actions">
        <a className="grocery-band-cta" href="/grocery">شروع خرید خونه <ArrowLeft size={16}/></a>
        <span className="grocery-band-note">سوپرمارکت‌های شهر هم به‌زودی سبد محصولاتشون رو می‌گذارن.</span>
      </div>
    </div>
    <div className="grocery-band-media">
      <img src={GROCERY_FLOW_IMAGE.src} alt={GROCERY_FLOW_IMAGE.alt} loading="lazy"/>
    </div>
  </section>

  <section id="businesses" className="listing"><div className="section-head"><div><div className="eyebrow muted">از آشپزخونه تا قفسهٔ سوپرمارکت</div><h2>امروز چی می‌خوای؟</h2></div><span className="filter-button">{filtered.length} کسب‌وکار <ChevronDown size={15}/></span></div><div className="categories">{categories.map((c,i)=>{const Icon=[Sparkles,Fish,ChefHat,Coffee,CakeSlice,Utensils][i%6]||Utensils;return <button key={c} className={category===c?'chosen':''} onClick={()=>setCategory(c)}><Icon size={14}/>{c}</button>;})}</div><div className="result-count">{loading?'دارم فهرست کسب‌وکارها رو می‌گیرم…':`${filtered.length} کسب‌وکار برای انتخاب تو · غذا یا خرید خونه`}</div>{loading?<SkeletonCards count={6}/>:<div className="restaurant-grid">{filtered.map(r=><button className="restaurant-card" key={r.id} onClick={()=>void openBusiness(r)}><div className={`restaurant-image ${r.accent}`}><img className="object-cover" src={photoFor(r.name,...r.categories).src} alt="" loading="lazy"/><span className="ribbon">{r.regionName}</span><span className="photo-label">تصویر پیشنهادی</span></div><div className="card-info"><div className="card-title"><h3>{r.name}</h3><span className="rating"><MapPin size={13}/>محلی</span></div><p>{r.categories.join(' · ')||'منوی غذایی'}</p><div className="card-meta"><span><Clock3 size={14}/>{r.time}</span><span className="dot">·</span><span>ارسال {r.deliveryFeeRial===null?'هزینه نامشخص':money(r.deliveryFeeRial)}</span></div></div></button>)}</div>}{!loading&&filtered.length===0&&<div className="empty">{loadError?`فهرست نیومد (${loadError})؛ اتصال API و دیتابیس رو چک کن.`:'این دسته هنوز کسب‌وکاری نداره؛ یه دستهٔ دیگه رو امتحان کن.'}</div>}</section>
  <section className="how" id="how">
    <div className="how-heading">
      <div className="eyebrow muted">دو سرویس، یک پیک</div>
      <h2>سفارش غذا یا خرید خونه،<br/>هر دو ساده.</h2>
    </div>
    <div className="steps">
      <div><b>۰۱</b><span>کشف کن</span><p>از رستوران‌ها و سوپرمارکت‌های محلی انتخاب کن.</p></div>
      <div><b>۰۲</b><span>سفارش بده</span><p>از منو انتخاب کن یا لیست خریدتو بنویس.</p></div>
      <div><b>۰۳</b><span>تأیید کن</span><p>هزینهٔ ارسال یا ماموریت رو شفاف ببین و تأیید کن.</p></div>
      <div><b>۰۴</b><span>تحویل بگیر</span><p>مسیر رو زنده ببین و نقدی یا کارت‌به‌کارت حساب کن.</p></div>
    </div>
  </section>
  </main><nav className="tabbar" aria-label="دسترسی سریع">
    <a className="active" href="#top"><Home size={20}/>خونه</a>
    <a href="#businesses"><Utensils size={20}/>غذا</a>
    <a href="/grocery"><ShoppingBasket size={20}/>خرید خونه</a>
    <a href="/orders"><ClipboardList size={20}/>سفارش‌ها</a>
    <a href="/notifications"><Bell size={20}/>اعلان‌ها{unreadNotifications>0&&<span>{new Intl.NumberFormat('fa-IR').format(unreadNotifications)}</span>}</a>
  </nav><footer><a className="brand" href="#top"><span className="brand-mark">ج</span><span>جتینو<small>محلی، راحت، نزدیک</small></span></a><span>ساخته‌شده با عشق برای بندر خمیر <b>♥</b></span><a className="footer-link" href="/orders">پیگیری سفارش</a><a className="footer-link" href="/grocery">خرید از سوپرمارکت</a><a className="footer-link" href="/notifications">اعلان‌ها</a><a className="footer-link" href="/join/business">ثبت کسب‌وکار</a><a className="footer-link" href="/join/driver">ثبت‌نام راننده</a><a className="footer-link" href="/business/orders">پنل کسب‌وکار</a><a className="footer-link" href="/driver/deliveries">ورود راننده</a><span>© جتینو ۱۴۰۵</span></footer>
  {selected&&<div className="overlay" onClick={()=>setSelected(null)}><div className="modal" onClick={e=>e.stopPropagation()}><button className="close" aria-label="بستن منو" onClick={()=>setSelected(null)}><X size={19}/></button><div className={`modal-cover ${selected.accent}`}><img src={photoFor(selected.name,...selected.categories).src} alt=""/><span className="photo-label">تصویر پیشنهادی</span></div><div className="modal-body"><div className="card-title"><div><h2>{selected.name}</h2><p>{selected.categories.join(' · ')||selected.regionName}</p></div><span className="rating"><MapPin size={14}/>{selected.regionName}</span></div><div className="modal-meta"><span><Clock3 size={15}/>{selected.time}</span><span>ارسال {selected.deliveryFeeRial===null?'هزینه نامشخص':money(selected.deliveryFeeRial)}</span></div><h3 className="menu-title">منو</h3>{menuLoading?<SkeletonDishes count={4}/>:menuError?<div className="empty">منو نیومد: {menuError}</div>:menu.flatMap(c=>c.products.map(p=><div className="dish" key={p.id}><div className={`dish-emoji${p.imageUrl?' real-photo':''}`}><img src={p.imageUrl||photoFor(p.name,c.name).src} alt={p.imageUrl?p.name:''} loading="lazy"/></div><div className="dish-info"><b>{p.name}</b><small>{p.description||c.name}</small><strong>{money(p.priceRial)}</strong></div><div className="dish-actions">{cart[p.id]&&<button className="quantity-mini" aria-label={`کم کردن ${p.name}`} onClick={()=>remove(p.id)}><Minus size={13}/></button>}<button className="add" aria-label="افزودن به سبد" onClick={()=>add(p,selected)}>{cart[p.id]?.quantity||<Plus size={18}/>}</button></div></div>))}{cartMessage&&<div className="checkout-error">{cartMessage}<button onClick={clearCart}>خالی کردن سبد</button></div>}</div><button className="modal-cart" disabled={selectedCount===0} onClick={()=>{setSelected(null);setCartOpen(true);}}>دیدن سبد خرید <ArrowLeft size={17}/>{selectedCount>0&&<span>{selectedCount} قلم</span>}</button></div></div>}
  {cartOpen&&<div className="overlay" onClick={()=>setCartOpen(false)}><div className="cart-drawer" onClick={e=>e.stopPropagation()}><div className="drawer-head"><div><h2>سبد خرید</h2><span>{count} قلم · {lines[0]?.businessId?restaurants.find(r=>r.id===lines[0].businessId)?.name:''}</span></div><button className="close" aria-label="بستن سبد خرید" onClick={()=>setCartOpen(false)}><X/></button></div>{count? <><div className="cart-lines">{lines.map(item=><div className="cart-line" key={item.productId}><span><img src={item.imageUrl||photoFor(item.name).src} alt="" loading="lazy"/></span><div><b>{item.name}</b><small>{money(item.priceRial)}</small></div><div className="quantity"><button aria-label={`کم کردن ${item.name}`} onClick={()=>remove(item.productId)}><Minus size={14}/></button>{item.quantity}<button aria-label={`افزودن ${item.name}`} onClick={()=>add({id:item.productId,name:item.name,description:item.description,priceRial:item.priceRial},restaurants.find(r=>r.id===item.businessId)!)}><Plus size={14}/></button></div></div>)}</div><div className="cart-total"><span>جمع اقلام</span><b>{money(subtotal)}</b></div>{cartMessage&&<div className="checkout-error">{cartMessage}</div>}<button className="checkout" onClick={checkout}>ادامه و ثبت سفارش نقدی <ArrowLeft size={17}/></button><button className="text-button" onClick={clearCart}>خالی کردن سبد</button></>:<div className="cart-empty"><span>🛍️</span><h3>سبدت هنوز خالیه</h3><p>یه کسب‌وکار انتخاب کن؛ غذا یا خرید خونه، هر چی لازم داری.</p><button onClick={()=>setCartOpen(false)}>دیدن کسب‌وکارها</button></div>}</div></div>}
  {checkoutOpen&&cartBusiness&&<CheckoutFlow businessId={cartBusiness} businessName={restaurants.find(r=>r.id===cartBusiness)?.name||'کسب‌وکار'} items={lines} onClose={()=>setCheckoutOpen(false)} onComplete={created=>{setCheckoutOpen(false);clearCart();setOrder(created);}}/>}
  {order&&<OrderSuccess order={order} onClose={()=>setOrder(null)}/>}
 </div>
}
export default App;
