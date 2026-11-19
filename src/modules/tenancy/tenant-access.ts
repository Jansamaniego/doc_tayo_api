import type { ErrorCode } from '../../common/errors/error-codes.js';
import type { ResolvedMembership } from './membership-resolver.js';

/**
 * The one rule for "may this user act in this tenant right now": an active
 * user with an ACTIVE membership of an ACTIVE tenant. Used by TenantGuard
 * (every request) and by switch-tenant, so the two can never drift apart.
 * Only active members may learn that a tenant is suspended or deactivated;
 * everyone else gets the same TENANT_ACCESS_DENIED.
 */
export function tenantAccessError(
  membership: ResolvedMembership | null,
): ErrorCode | null {
  if (
    !membership ||
    membership.userStatus !== 'active' ||
    membership.membershipStatus !== 'active'
  ) {
    return 'TENANT_ACCESS_DENIED';
  }
  if (membership.tenantStatus === 'suspended') return 'TENANT_SUSPENDED';
  if (membership.tenantStatus === 'deactivated') return 'TENANT_DEACTIVATED';
  return null;
}
