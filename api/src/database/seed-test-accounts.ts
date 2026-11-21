import 'dotenv/config';
import { Client } from 'pg';

/**
 * One login per surface, so the MVP can be walked end to end without a SMS provider: an operator
 * signs in as the customer, then as the business owner, then as the driver, and sees the same order
 * move through the states the PRD defines. Phones are fixed and every statement is idempotent, so
 * the script can be re-run after a restore or a fresh migration.
 *
 * Nothing here can be used to break into a deployment: these rows carry no credentials. A login
 * still needs a code from the OTP flow, which only echoes the code when `JETINO_ALLOW_TEST_OTP=yes`
 * is set on the server (see AuthService.requestOtp). Remove that variable and the accounts are inert.
 */
export const REGION_SLUG = 'bandar-khamir';
/**
 * The demo courier photo and dish photos are shipped inside `public/images`. The API only stores
 * https links (or validated data URLs), so the seed points at this deployment by default — set
 * `JETINO_PUBLIC_URL` when seeding a different origin.
 */
const ASSET_BASE = (process.env.JETINO_PUBLIC_URL || 'https://jetino-omega.vercel.app').replace(/\/+$/, '');
const regionId = `(SELECT id FROM regions WHERE slug='${REGION_SLUG}')`;

export type TestAccount = {
  id: string;
  phone: string;
  displayName: string;
  roles: string[];
  surface: string;
};

export const TEST_ACCOUNTS: TestAccount[] = [
  { id: '20000000-0000-4000-8000-000000000021', phone: '+989120000021', displayName: 'مشتری نمونه', roles: ['CUSTOMER'], surface: 'فروشگاه، سبد خرید و پیگیری سفارش' },
  { id: '20000000-0000-4000-8000-000000000022', phone: '+989120000022', displayName: 'مالک کبابی نمونه', roles: ['BUSINESS_OWNER'], surface: 'پنل کسب‌وکار: سفارش‌ها و منو' },
  { id: '20000000-0000-4000-8000-000000000023', phone: '+989120000023', displayName: 'پیک نمونه', roles: ['DRIVER'], surface: 'پنل راننده: تخصیص، تحویل و وصول نقدی' },
  { id: '20000000-0000-4000-8000-000000000024', phone: '+989120000024', displayName: 'مدیر عملیات نمونه', roles: ['OPERATIONS_MANAGER'], surface: 'پنل مدیریت: تخصیص پیک، تسویه، دفتر ارسال' },
  { id: '20000000-0000-4000-8000-000000000025', phone: '+989120000025', displayName: 'مدیر ارشد نمونه', roles: ['SUPER_ADMIN'], surface: 'تنظیمات مالی، تأیید کسب‌وکارها و audit log' },
  { id: '20000000-0000-4000-8000-000000000026', phone: '+989120000026', displayName: 'پشتیبان نمونه', roles: ['SUPPORT'], surface: 'تیکت‌های پشتیبانی و بازبینی امتیازها' },
];

const BUSINESS_ID = '20000000-0000-4000-8000-000000000031';
const CATEGORY_ID = '20000000-0000-4000-8000-000000000032';
const DRIVER_ID = '20000000-0000-4000-8000-000000000033';
const ADDRESS_ID = '20000000-0000-4000-8000-000000000034';
const OWNER = TEST_ACCOUNTS[1];
const CUSTOMER = TEST_ACCOUNTS[0];
const DRIVER = TEST_ACCOUNTS[2];

/** The SQL, in order, with every fixed value inlined so the same text works in psql and in the platform editor. */
export function buildStatements(): string[] {
  const statements: string[] = [];
  for (const account of TEST_ACCOUNTS) {
    statements.push(
      `INSERT INTO users(id,phone,display_name) VALUES ('${account.id}','${account.phone}','${account.displayName}') ON CONFLICT(id) DO UPDATE SET phone=EXCLUDED.phone, display_name=EXCLUDED.display_name, status='ACTIVE', updated_at=now()`,
    );
    for (const role of account.roles) {
      statements.push(`INSERT INTO user_roles(user_id,role) VALUES ('${account.id}','${role}') ON CONFLICT DO NOTHING`);
    }
  }
  statements.push(
    // `businesses` grew no `updated_at` column in 001/012, so this upsert must not mention one —
    // the same reason the two menu tables below stop at their own columns.
    `INSERT INTO businesses(id,owner_id,region_id,name,description,status,latitude,longitude) VALUES ('${BUSINESS_ID}','${OWNER.id}',${regionId},'کبابی نمونه','کسب‌وکار آزمایشی جتینو؛ فقط برای تست محیط.','ACTIVE',27.182,56.267) ON CONFLICT(id) DO UPDATE SET owner_id=EXCLUDED.owner_id, region_id=EXCLUDED.region_id, name=EXCLUDED.name, status='ACTIVE', latitude=EXCLUDED.latitude, longitude=EXCLUDED.longitude`,
    `INSERT INTO menu_categories(id,business_id,name,sort_order) VALUES ('${CATEGORY_ID}','${BUSINESS_ID}','کباب',1) ON CONFLICT(id) DO UPDATE SET business_id=EXCLUDED.business_id, name=EXCLUDED.name, sort_order=EXCLUDED.sort_order`,
    `INSERT INTO products(id,category_id,name,description,price_rial,is_available,image_url) VALUES ('20000000-0000-4000-8000-000000000035','${CATEGORY_ID}','چلوکباب کوبده','دو سیخ کوبده با برنج و گوجه کبابی',1850000,true,'${ASSET_BASE}/images/cat-kebab.jpg') ON CONFLICT(id) DO UPDATE SET category_id=EXCLUDED.category_id, price_rial=EXCLUDED.price_rial, is_available=true, image_url=EXCLUDED.image_url`,
    `INSERT INTO products(id,category_id,name,description,price_rial,is_available,image_url) VALUES ('20000000-0000-4000-8000-000000000036','${CATEGORY_ID}','جوجه‌کباب','یک سیخ جوجه زعفرانی با برنج',1650000,true,'${ASSET_BASE}/images/cat-kebab.jpg') ON CONFLICT(id) DO UPDATE SET category_id=EXCLUDED.category_id, price_rial=EXCLUDED.price_rial, is_available=true, image_url=EXCLUDED.image_url`,
    `INSERT INTO drivers(id,user_id,region_id,status,full_name,vehicle_type,plate_number,photo_url) VALUES ('${DRIVER_ID}','${DRIVER.id}',${regionId},'ACTIVE','پیک نمونه','MOTORCYCLE','12ب34567','${ASSET_BASE}/images/rider-demo.jpg') ON CONFLICT(user_id) DO UPDATE SET region_id=EXCLUDED.region_id, status='ACTIVE', full_name=EXCLUDED.full_name, vehicle_type=EXCLUDED.vehicle_type, plate_number=EXCLUDED.plate_number, photo_url=EXCLUDED.photo_url, updated_at=now()`,
    `INSERT INTO addresses(id,user_id,region_id,label,address_text,latitude,longitude,is_default) VALUES ('${ADDRESS_ID}','${CUSTOMER.id}',${regionId},'خانه','خیابان شهدا، پلاک ۱۲، واحد ۳ — بندرخمیر',27.177,56.269,true) ON CONFLICT(id) DO UPDATE SET user_id=EXCLUDED.user_id, region_id=EXCLUDED.region_id, address_text=EXCLUDED.address_text, latitude=EXCLUDED.latitude, longitude=EXCLUDED.longitude, is_default=true`,
  );
  return statements;
}

export function accountsReport(): string {
  const rows = TEST_ACCOUNTS.map((account) => `${account.phone.padEnd(14)} ${account.roles.join('+').padEnd(20)} ${account.surface}`);
  return ['number            role                 what it opens', ...rows].join('\n');
}

async function seed() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must be set');
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const region = await client.query('SELECT id FROM regions WHERE slug=$1', [REGION_SLUG]);
    if (!region.rowCount) throw new Error(`Region "${REGION_SLUG}" is missing — run the migrations and npm run db:seed:demo first.`);
    await client.query('BEGIN');
    try {
      for (const sql of buildStatements()) await client.query(sql);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
    console.log('test accounts are ready (development data only, no credentials):');
    console.log(accountsReport());
    console.log(
      process.env.JETINO_ALLOW_TEST_OTP === 'yes'
        ? 'login works here because JETINO_ALLOW_TEST_OTP=yes returns the code in the response.'
        : 'set JETINO_ALLOW_TEST_OTP=yes to receive the code in the response; without it these accounts cannot sign in unless SMS is configured.',
    );
  } finally {
    await client.end();
  }
}

if (require.main === module) void seed().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
