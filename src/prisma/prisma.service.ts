import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { databaseConfig, appConfig } from '../config/configuration.js';
import { PrismaClient } from '../generated/prisma/client.js';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  constructor(
    @Inject(databaseConfig.KEY)
    private readonly db: ConfigType<typeof databaseConfig>,
    @Inject(appConfig.KEY) private readonly app: ConfigType<typeof appConfig>,
  ) {
    super({
      adapter: new PrismaPg(
        {
          connectionString: db.url,
          max: db.poolMax,
          ssl:
            db.ssl === 'disable'
              ? false
              : { rejectUnauthorized: db.ssl === 'verify-full' },
        },
        { schema: db.schema },
      ),
      // The password hash never leaves the database unless code asks for it
      // with an explicit `select` (credentials code only).
      omit: { user: { passwordHash: true } },
      // Never log queries (parameters can contain patient data).
      log: [
        { emit: 'event', level: 'warn' },
        { emit: 'event', level: 'error' },
      ],
    });
  }

  async onModuleInit() {
    // Fail fast: the app does not start without its database.
    await this.$connect();
    await this.assertLeastPrivilege();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }

  /**
   * The runtime role must not be a superuser or bypass row-level security.
   * Refuses to start in production; warns elsewhere.
   */
  private async assertLeastPrivilege() {
    const rows = await this.$queryRaw<
      { rolsuper: boolean; rolbypassrls: boolean }[]
    >`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
    const role = rows[0];
    if (!role || role.rolsuper || role.rolbypassrls) {
      const message =
        'Database role is a superuser or bypasses row-level security; use the least-privilege runtime role.';
      if (this.app.env === 'production') throw new Error(message);
      this.logger.warn(message);
    }
  }
}

/** The transaction client handed to `PrismaService.$transaction` callbacks. */
export type PrismaTransaction = Parameters<
  Parameters<PrismaService['$transaction']>[0]
>[0];
