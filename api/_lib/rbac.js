import { sha256, safeEqual } from './crypto.js';

export const ROLES = {
  USER: 'user',
  DEVELOPER: 'developer',
  OWNER: 'owner',
};

/**
 * Every permission in the Owner / Developer system.
 * `devs:manage` is strictly reserved for the Owner and can never be granted to
 * a Developer account.
 */
export const PERMISSIONS = {
  OVERVIEW_READ: 'overview:read',     // View application overview, system monitor & DB structure
  METRICS_READ: 'metrics:read',       // View API monitor & performance metrics
  LOGS_READ: 'logs:read',             // View error logs & developer activity logs
  SECURITY_READ: 'security:read',     // View security audit reports
  DATA_INSPECT: 'data:inspect',       // Inspect sanitized document metadata & run orphan cleanup
  USERS_READ: 'users:read',           // View registered accounts, plans & roles
  USERS_WRITE: 'users:write',         // Modify user plans/credits & revoke user sessions
  SETTINGS_READ: 'settings:read',     // View application settings & feature flags
  SETTINGS_WRITE: 'settings:write',   // Update runtime application settings
  DEVS_MANAGE: 'devs:manage',         // Owner-only: promote/demote developers & assign permissions
};

export const ALL_PERMISSIONS = Object.values(PERMISSIONS);

export const DEVELOPER_GRANTABLE_PERMISSIONS = ALL_PERMISSIONS.filter(
  (p) => p !== PERMISSIONS.DEVS_MANAGE,
);

export const DEFAULT_DEVELOPER_PERMISSIONS = [
  PERMISSIONS.OVERVIEW_READ,
  PERMISSIONS.METRICS_READ,
  PERMISSIONS.LOGS_READ,
  PERMISSIONS.SECURITY_READ,
  PERMISSIONS.SETTINGS_READ,
];

function cleanEmail(raw) {
  if (typeof raw !== 'string') return '';
  return raw.trim().toLowerCase();
}

/**
 * Constant-time check whether an email matches the configured OWNER_EMAIL.
 * Never hardcodes credentials in source code — configured via OWNER_EMAIL env var.
 */
export function isConfiguredOwnerEmail(email) {
  const candidate = cleanEmail(email);
  const configured = cleanEmail(process.env.OWNER_EMAIL || '');
  if (!candidate || !configured) return false;
  return safeEqual(sha256(candidate), sha256(configured));
}

/**
 * Resolve the authoritative role and permission list for a user record.
 * - If the user's email matches OWNER_EMAIL, role is always 'owner' with all permissions.
 * - If a user record was somehow marked 'owner' in storage without matching OWNER_EMAIL,
 *   it is downgraded to 'user' to prevent privilege escalation.
 * - If role is 'developer', only valid grantable permissions on the record are returned.
 */
export function resolveUserRoleAndPermissions(user) {
  if (!user || !user.email) {
    return { role: ROLES.USER, permissions: [] };
  }

  if (isConfiguredOwnerEmail(user.email)) {
    return {
      role: ROLES.OWNER,
      permissions: [...ALL_PERMISSIONS],
    };
  }

  if (user.role === ROLES.DEVELOPER) {
    const rawPerms = Array.isArray(user.permissions)
      ? user.permissions
      : DEFAULT_DEVELOPER_PERMISSIONS;
    const valid = rawPerms.filter((p) => DEVELOPER_GRANTABLE_PERMISSIONS.includes(p));
    return {
      role: ROLES.DEVELOPER,
      permissions: [...new Set(valid)],
    };
  }

  return {
    role: ROLES.USER,
    permissions: [],
  };
}

export function sanitizeDeveloperPermissions(input) {
  if (!Array.isArray(input)) return [...DEFAULT_DEVELOPER_PERMISSIONS];
  const valid = input
    .map((p) => String(p || '').trim())
    .filter((p) => DEVELOPER_GRANTABLE_PERMISSIONS.includes(p));
  return [...new Set(valid)];
}

export function hasPermission(ctxOrPerms, permission) {
  if (!permission) return false;
  if (Array.isArray(ctxOrPerms)) {
    return ctxOrPerms.includes(permission);
  }
  if (ctxOrPerms?.role === ROLES.OWNER) return true;
  const perms = ctxOrPerms?.permissions;
  return Array.isArray(perms) && perms.includes(permission);
}

export function isStaffRole(role) {
  return role === ROLES.OWNER || role === ROLES.DEVELOPER;
}
