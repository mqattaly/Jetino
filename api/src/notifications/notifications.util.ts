import type { PoolClient } from 'pg';

/** Anything that can run a statement in the caller's transaction — a PoolClient, or a narrower wrapper. */
export type Notifier = { query(sql: string, values?: unknown[]): Promise<unknown> };

export async function notify(client:PoolClient|Notifier,userId:string,eventType:string,title:string,body:string,data:Record<string,unknown>={}){
 await (client as Notifier).query(`INSERT INTO notifications(user_id,event_type,title,body,data) VALUES($1,$2,$3,$4,$5::jsonb)`,[userId,eventType,title,body,JSON.stringify(data)]);
}
