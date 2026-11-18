import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../database/database.module';

type Principal = { sub: string; roles?: string[] };
type Pin = { latitude: number; longitude: number };
type LocationState = { available: false; reason: 'BUSINESS_LOCATION_MISSING' | 'DESTINATION_LOCATION_MISSING'; message: string };
type RoutingState = {
  available: true;
  source: 'NESHAN' | 'ESTIMATED';
  distanceMeters: number;
  durationMinutes: number;
  note?: string;
  cached: boolean;
  measuredAt: string;
};
type OrderEstimate = (RoutingState | LocationState) & { orderId: string };

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STAFF_ROLES = ['SUPER_ADMIN', 'OPERATIONS_MANAGER'];
const ROAD_FACTOR = 1.35;
const AVERAGE_SPEED_METERS_PER_MINUTE = 430; // ~26 km/h in city traffic
const CACHE_TTL_MS = 15 * 60 * 1000;
const CACHE_MAX_ENTRIES = 500;
const DIRECTION_TYPES = ['car', 'walk', 'transit', 'bicycle'];

@Injectable()
export class DeliveryService {
  private readonly cache = new Map<string, { expiresAt: number; estimate: RoutingState }>();
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** Read on every call so a rotated key or a test override applies immediately. */
  private get serverKey(): string { return (process.env.NESHAN_SERVER_KEY ?? '').trim(); }
  private get directionsUrl(): string { return (process.env.NESHAN_DIRECTION_URL ?? 'https://api.neshan.org/v4/direction').trim(); }
  private get directionsType(): string {
    const raw = (process.env.NESHAN_DIRECTION_TYPE ?? 'car').trim();
    return DIRECTION_TYPES.includes(raw) ? raw : 'car';
  }
  private get timeoutMs(): number {
    const raw = Number(process.env.NESHAN_TIMEOUT_MS ?? 3500);
    return Number.isFinite(raw) && raw >= 500 && raw <= 15000 ? raw : 3500;
  }

  private async orderPins(user: Principal, orderId: string) {
    // every id in this query is compared against a uuid column, so a malformed
    // subject must be refused here instead of letting PostgreSQL raise a 500
    if (!uuidPattern.test(user.sub)) throw new NotFoundException('سفارش پیدا نشد یا به این حساب مربوط نیست.');
    const result = await this.pool.query(
      `SELECT o.id,b.latitude AS "originLatitude",b.longitude AS "originLongitude",
              o.delivery_latitude_snapshot AS "destinationLatitude",o.delivery_longitude_snapshot AS "destinationLongitude"
       FROM orders o
       JOIN businesses b ON b.id=o.business_id
       LEFT JOIN delivery_assignments da ON da.order_id=o.id
       LEFT JOIN drivers d ON d.id=da.driver_id
       WHERE o.id=$1 AND (o.customer_id=$2 OR b.owner_id=$2 OR d.user_id=$2 OR $3::boolean)`,
      [orderId, user.sub, STAFF_ROLES.some(role => user.roles?.includes(role))],
    );
    if (!result.rowCount) throw new NotFoundException('سفارش پیدا نشد یا به این حساب مربوط نیست.');
    return result.rows[0] as { id: string; originLatitude: string | null; originLongitude: string | null; destinationLatitude: string | null; destinationLongitude: string | null };
  }

  private static number(value: string | null): number | null {
    if (value === null || value === undefined || value === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private static pin(latitude: string | null, longitude: string | null): Pin | null {
    const lat = DeliveryService.number(latitude);
    const lng = DeliveryService.number(longitude);
    return lat === null || lng === null ? null : { latitude: lat, longitude: lng };
  }

  private static haversineMeters(from: Pin, to: Pin): number {
    const radians = (degrees: number) => (degrees * Math.PI) / 180;
    const dLat = radians(to.latitude - from.latitude);
    const dLng = radians(to.longitude - from.longitude);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(radians(from.latitude)) * Math.cos(radians(to.latitude)) * Math.sin(dLng / 2) ** 2;
    return 6_371_000 * 2 * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  /**
   * Without a routing key the platform still owes the dispatcher a number, so it
   * degrades to a straight line stretched to a road distance. It is labelled
   * ESTIMATED everywhere it appears and never cached, so a later real route wins.
   */
  private fallback(from: Pin, to: Pin, note: string): RoutingState {
    const distanceMeters = Math.round(DeliveryService.haversineMeters(from, to) * ROAD_FACTOR);
    return {
      available: true,
      source: 'ESTIMATED',
      distanceMeters,
      durationMinutes: Math.max(1, Math.round(distanceMeters / AVERAGE_SPEED_METERS_PER_MINUTE)),
      note,
      cached: false,
      measuredAt: new Date().toISOString(),
    };
  }

  private remember(key: string, estimate: RoutingState) {
    if (this.cache.size >= CACHE_MAX_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, estimate });
  }

  async estimateForOrder(user: Principal, orderIdInput: unknown): Promise<OrderEstimate> {
    if (typeof orderIdInput !== 'string' || !uuidPattern.test(orderIdInput)) throw new BadRequestException('شناسهٔ سفارش معتبر نیست.');
    const order = await this.orderPins(user, orderIdInput);
    const origin = DeliveryService.pin(order.originLatitude, order.originLongitude);
    if (!origin) {
      return { available: false, reason: 'BUSINESS_LOCATION_MISSING', message: 'برای محاسبهٔ مسیر، صاحب کسب‌وکار باید محل فروشگاه را ثبت کند.', orderId: order.id };
    }
    const destination = DeliveryService.pin(order.destinationLatitude, order.destinationLongitude);
    if (!destination) {
      return { available: false, reason: 'DESTINATION_LOCATION_MISSING', message: 'این نشانی مختصات ندارد؛ برآورد مسیر فقط پس از ثبت مختصات ممکن است.', orderId: order.id };
    }

    const cacheKey = `${origin.latitude.toFixed(4)},${origin.longitude.toFixed(4)}>${destination.latitude.toFixed(4)},${destination.longitude.toFixed(4)}`;
    const hit = this.cache.get(cacheKey);
    if (hit) {
      if (hit.expiresAt > Date.now()) return { ...hit.estimate, cached: true, orderId: order.id };
      this.cache.delete(cacheKey);
    }

    if (!this.serverKey) {
      const estimate = this.fallback(origin, destination, 'کلید مسیریابی نشان تنظیم نشده؛ مقدار تقریبی خط مستقیم است.');
      return { ...estimate, orderId: order.id };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const url = `${this.directionsUrl}?type=${this.directionsType}&origin=${origin.latitude},${origin.longitude}&destination=${destination.latitude},${destination.longitude}`;
      const response = await fetch(url, { headers: { 'Api-Key': this.serverKey }, signal: controller.signal });
      if (!response.ok) throw new Error(`status ${response.status}`);
      const payload = (await response.json()) as { routes?: Array<{ legs?: Array<{ distance?: { value?: number }; duration?: { value?: number } }> }> };
      const leg = payload?.routes?.[0]?.legs?.[0];
      const meters = Number(leg?.distance?.value);
      const seconds = Number(leg?.duration?.value);
      if (!Number.isFinite(meters) || meters < 0 || !Number.isFinite(seconds) || seconds < 0) throw new Error('unexpected payload');
      const estimate: RoutingState = {
        available: true,
        source: 'NESHAN',
        distanceMeters: Math.round(meters),
        durationMinutes: Math.max(1, Math.round(seconds / 60)),
        cached: false,
        measuredAt: new Date().toISOString(),
      };
      this.remember(cacheKey, estimate);
      return { ...estimate, orderId: order.id };
    } catch {
      // the upstream error is never forwarded: it can echo the request URL and headers
      return { ...this.fallback(origin, destination, 'مسیریابی نشان پاسخ نداد؛ مقدار تقریبی خط مستقیم نمایش داده شده است.'), orderId: order.id };
    } finally {
      clearTimeout(timer);
    }
  }
}
