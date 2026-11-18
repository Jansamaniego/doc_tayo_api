import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'doctayo:isPublic';

/** No authentication, no tenant, no permissions (health checks, docs). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
