import type { PoolClient } from 'pg';

export async function notify(client:PoolClient,userId:string,eventType:string,title:string,body:string,data:Record<string,unknown>={}){
 await client.query(`INSERT INTO notifications(user_id,event_type,title,body,data) VALUES($1,$2,$3,$4,$5::jsonb)`,[userId,eventType,title,body,JSON.stringify(data)]);
}
