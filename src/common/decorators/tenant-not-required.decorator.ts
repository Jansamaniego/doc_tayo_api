import { SetMetadata } from '@nestjs/common';

export const TENANT_NOT_REQUIRED_KEY = 'doctayo:tenantNotRequired';

/** Authenticated, but needs no active tenant (e.g. /me, switch-tenant). */
export const TenantNotRequired = () =>
  SetMetadata(TENANT_NOT_REQUIRED_KEY, true);
