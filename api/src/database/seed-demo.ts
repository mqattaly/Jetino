import 'dotenv/config';
import { Client } from 'pg';
import { requireDatabaseUrl } from '../config/database-url';

async function seed() {
  const client = new Client({connectionString:requireDatabaseUrl()}); await client.connect();
  try {
    await client.query('BEGIN');
    const region = await client.query(`SELECT id FROM regions WHERE slug='bandar-khamir'`);
    if (!region.rowCount) throw new Error('Run all database migrations before seeding.');
    const ownerId='10000000-0000-4000-8000-000000000001';
    const businessId='10000000-0000-4000-8000-000000000002';
    const categoryId='10000000-0000-4000-8000-000000000003';
    await client.query(`INSERT INTO users(id,phone,display_name) VALUES($1,'+989120000000','نمونهٔ جتینو') ON CONFLICT(id) DO NOTHING`,[ownerId]);
    await client.query(`INSERT INTO businesses(id,owner_id,region_id,name,description,status) VALUES($1,$2,$3,'دریایی ناخدا','غذاهای دریایی و طعم‌های جنوبی؛ دادهٔ نمونهٔ توسعه.', 'ACTIVE') ON CONFLICT(id) DO NOTHING`,[businessId,ownerId,region.rows[0].id]);
    await client.query(`INSERT INTO menu_categories(id,business_id,name,sort_order) VALUES($1,$2,'غذاهای جنوبی',1) ON CONFLICT(id) DO NOTHING`,[categoryId,businessId]);
    const products=[
      ['10000000-0000-4000-8000-000000000004','میگو سوخاری ویژه','میگوی تازه، برنج زعفرانی و سس دست‌ساز',3200000],
      ['10000000-0000-4000-8000-000000000005','قلیه‌ماهی جنوبی','ماهی روز، سبزی محلی و چاشنی جنوبی',2850000],
      ['10000000-0000-4000-8000-000000000006','ماهی کبابی','ماهی تازه کباب‌شده با دورچین',3500000],
    ] as const;
    for(const [id,name,description,price] of products) await client.query(
      `INSERT INTO products(id,category_id,name,description,price_rial,is_available) VALUES($1,$2,$3,$4,$5,true) ON CONFLICT(id) DO NOTHING`,[id,categoryId,name,description,price],
    );
    await client.query('COMMIT'); console.log('Demo restaurant and menu are ready (development data only).');
  } catch(error) { try{await client.query('ROLLBACK');}catch{/* closed */} throw error; }
  finally { await client.end(); }
}
void seed().catch((error:unknown)=>{console.error(error);process.exitCode=1;});
