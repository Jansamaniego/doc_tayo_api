import { SetMetadata } from '@nestjs/common';
import type { PermissionKey } from '../../modules/access-control/catalog.js';

export const PERMISSIONS_KEY = 'doctayo:permissions';

/** Every listed permission is required. A tenant route without it is denied. */
export const RequirePermissions = (...permissions: PermissionKey[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);
