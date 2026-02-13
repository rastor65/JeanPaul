export type Role = 'worker' | 'staff' | 'superadmin';

export type Feature =
  | 'home'         // inicio (todos)
  | 'agenda'       // trabajadores
  | 'catalogo'     // staff, superadmin
  | 'turnos'       // staff, superadmin
  | 'usuarios'     // superadmin
  | 'horarios'     // staff, superadmin
  | 'contabilidad' // superadmin
;

export interface AuthUserLike {
  is_staff?: boolean | null;
  is_superuser?: boolean | null;
}

export const FEATURE_ACCESS: Record<Feature, Role[]> = {
  home: ['worker', 'staff', 'superadmin'],

  agenda: ['worker'],

  catalogo: ['staff', 'superadmin'],
  turnos: ['staff', 'superadmin'],
  horarios: ['staff', 'superadmin'],

  usuarios: ['superadmin'],
  contabilidad: ['superadmin'],
};

export function roleFromUser(user: AuthUserLike | null | undefined): Role {
  if (!user) return 'worker';
  if (user.is_superuser) return 'superadmin';
  if (user.is_staff) return 'staff';
  return 'worker';
}

export function canAccessFeature(user: AuthUserLike | null | undefined, feature: Feature): boolean {
  const r = roleFromUser(user);
  return (FEATURE_ACCESS[feature] || []).includes(r);
}
