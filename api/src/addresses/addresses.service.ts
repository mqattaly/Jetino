import { Inject, Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../database/database.module';

type Principal = { sub: string };
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const addressFields = 'id,label,address_text AS "addressText",instructions,latitude,longitude,is_default AS "isDefault",created_at AS "createdAt"';

@Injectable()
export class AddressesService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  private id(value: unknown) {
    if (typeof value !== 'string' || !uuidPattern.test(value)) throw new BadRequestException('شناسهٔ نشانی معتبر نیست.');
    return value;
  }
  private text(value: unknown, field: string, max: number, required = false): string | null {
    if (value === undefined || value === null) {
      if (required) throw new BadRequestException(`${field} الزامی است.`);
      return null;
    }
    if (typeof value !== 'string' || (required && !value.trim()) || value.trim().length > max) throw new BadRequestException(`${field} معتبر نیست.`);
    return value.trim() || null;
  }
  private coordinate(value: unknown, min: number, max: number): number | null {
    if (value === undefined || value === null || value === '') return null;
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n) || n < min || n > max) throw new BadRequestException('مختصات مکانی معتبر نیست.');
    return n;
  }

  async list(user: Principal) {
    const result = await this.pool.query(
      `SELECT ${addressFields},r.slug AS "regionSlug",r.name AS "regionName" FROM addresses a JOIN regions r ON r.id=a.region_id WHERE a.user_id=$1 ORDER BY a.is_default DESC,a.created_at DESC`, [user.sub],
    );
    return result.rows;
  }

  async create(user: Principal, body: { label?: unknown; addressText?: unknown; instructions?: unknown; latitude?: unknown; longitude?: unknown; regionSlug?: unknown; isDefault?: unknown }) {
    const label = this.text(body?.label, 'عنوان نشانی', 80, true)!;
    const addressText = this.text(body?.addressText, 'آدرس', 500, true)!;
    const instructions = this.text(body?.instructions, 'توضیحات تحویل', 500);
    const latitude = this.coordinate(body?.latitude, -90, 90); const longitude = this.coordinate(body?.longitude, -180, 180);
    if ((latitude === null) !== (longitude === null)) throw new BadRequestException('عرض و طول جغرافیایی باید هر دو وارد شوند.');
    if (body?.isDefault !== undefined && typeof body.isDefault !== 'boolean') throw new BadRequestException('وضعیت نشانی پیش‌فرض معتبر نیست.');
    const regionSlug = typeof body?.regionSlug === 'string' ? body.regionSlug : 'bandar-khamir';
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const region = await client.query('SELECT id FROM regions WHERE slug=$1 AND is_active=true', [regionSlug]);
      if (!region.rowCount) throw new NotFoundException('منطقهٔ فعال پیدا نشد.');
      const makeDefault = body?.isDefault === true;
      if (makeDefault) await client.query('UPDATE addresses SET is_default=false WHERE user_id=$1 AND is_default=true', [user.sub]);
      const result = await client.query(
        `INSERT INTO addresses(user_id,region_id,label,address_text,instructions,latitude,longitude,is_default) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${addressFields}`,
        [user.sub,region.rows[0].id,label,addressText,instructions,latitude,longitude,makeDefault],
      );
      await client.query(`INSERT INTO audit_logs(actor_id,action,entity_type,entity_id) VALUES($1,'ADDRESS_CREATED','ADDRESS',$2)`, [user.sub,result.rows[0].id]);
      await client.query('COMMIT');
      return result.rows[0];
    } catch (error) { try { await client.query('ROLLBACK'); } catch { /* transaction already closed */ } throw error; }
    finally { client.release(); }
  }

  async update(user: Principal, addressInput: unknown, body: { label?: unknown; addressText?: unknown; instructions?: unknown; latitude?: unknown; longitude?: unknown; isDefault?: unknown }) {
    const id = this.id(addressInput); const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query(`SELECT label,address_text,instructions,latitude,longitude,is_default FROM addresses WHERE id=$1 AND user_id=$2 FOR UPDATE`, [id,user.sub]);
      if (!current.rowCount) throw new NotFoundException('نشانی پیدا نشد.');
      const old = current.rows[0];
      const label = body?.label === undefined ? old.label : this.text(body.label,'عنوان نشانی',80,true);
      const addressText = body?.addressText === undefined ? old.address_text : this.text(body.addressText,'آدرس',500,true);
      const instructions = body?.instructions === undefined ? old.instructions : this.text(body.instructions,'توضیحات تحویل',500);
      const latitude = body?.latitude === undefined ? (old.latitude === null ? null : Number(old.latitude)) : this.coordinate(body.latitude,-90,90);
      const longitude = body?.longitude === undefined ? (old.longitude === null ? null : Number(old.longitude)) : this.coordinate(body.longitude,-180,180);
      if ((latitude === null) !== (longitude === null)) throw new BadRequestException('عرض و طول جغرافیایی باید هر دو وارد شوند.');
      const isDefault = body?.isDefault === undefined ? old.is_default : body.isDefault;
      if (typeof isDefault !== 'boolean') throw new BadRequestException('وضعیت نشانی پیش‌فرض معتبر نیست.');
      if (isDefault) await client.query('UPDATE addresses SET is_default=false WHERE user_id=$1 AND is_default=true', [user.sub]);
      const result = await client.query(
        `UPDATE addresses SET label=$3,address_text=$4,instructions=$5,latitude=$6,longitude=$7,is_default=$8,updated_at=now() WHERE id=$1 AND user_id=$2 RETURNING ${addressFields}`,
        [id,user.sub,label,addressText,instructions,latitude,longitude,isDefault],
      );
      await client.query(`INSERT INTO audit_logs(actor_id,action,entity_type,entity_id) VALUES($1,'ADDRESS_UPDATED','ADDRESS',$2)`, [user.sub,id]);
      await client.query('COMMIT'); return result.rows[0];
    } catch (error) { try { await client.query('ROLLBACK'); } catch { /* transaction already closed */ } throw error; }
    finally { client.release(); }
  }

  async delete(user: Principal, addressInput: unknown) {
    const id = this.id(addressInput);
    const result = await this.pool.query('DELETE FROM addresses WHERE id=$1 AND user_id=$2 RETURNING id', [id,user.sub]);
    if (!result.rowCount) throw new NotFoundException('نشانی پیدا نشد.');
    await this.pool.query(`INSERT INTO audit_logs(actor_id,action,entity_type,entity_id) VALUES($1,'ADDRESS_DELETED','ADDRESS',$2)`, [user.sub,id]);
    return { deleted: true, id };
  }
}
