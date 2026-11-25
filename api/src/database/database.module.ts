import { Global, Module } from '@nestjs/common';
import { Pool } from 'pg';
import { databaseUrl } from '../config/database-url';

export const PG_POOL = 'PG_POOL';

@Global()
@Module({
  providers: [{
    provide: PG_POOL,
    // `databaseUrl()` also understands the split DB_HOST/DB_USER/... form some panels inject
    useFactory: () => new Pool({ connectionString: databaseUrl() }),
  }],
  exports: [PG_POOL],
})
export class DatabaseModule {}
