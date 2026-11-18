/**
 * Code is the source of truth for permissions and system-role templates.
 * Rows in `permissions` are inserted by the migration that introduces a key;
 * a test asserts the table equals this catalog. See docs/authorization.md.
 */
export const PERMISSIONS = {
  TENANT_READ: 'tenant.read',
  TENANT_SETTINGS_MANAGE: 'tenant.settings.manage',
  BRANCHES_READ: 'branches.read',
  BRANCHES_MANAGE: 'branches.manage',
} as const;

export type PermissionKey = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const PERMISSION_KEYS: readonly PermissionKey[] =
  Object.values(PERMISSIONS);

export const PERMISSION_DESCRIPTIONS: Record<PermissionKey, string> = {
  'tenant.read': 'View the clinic profile',
  'tenant.settings.manage': 'Edit clinic settings',
  'branches.read': 'View branches',
  'branches.manage': 'Create and edit branches',
};

export interface RoleTemplate {
  key: string;
  name: string;
  permissions: readonly PermissionKey[];
}

const READ_ONLY: readonly PermissionKey[] = [
  PERMISSIONS.TENANT_READ,
  PERMISSIONS.BRANCHES_READ,
];

export const ROLE_TEMPLATES: readonly RoleTemplate[] = [
  { key: 'owner', name: 'Owner', permissions: PERMISSION_KEYS },
  { key: 'clinic_admin', name: 'Clinic Admin', permissions: PERMISSION_KEYS },
  { key: 'doctor', name: 'Doctor', permissions: READ_ONLY },
  { key: 'nurse', name: 'Nurse', permissions: READ_ONLY },
  { key: 'receptionist', name: 'Receptionist', permissions: READ_ONLY },
];
