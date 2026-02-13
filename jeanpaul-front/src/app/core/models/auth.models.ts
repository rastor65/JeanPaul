export type UserRole = 'admin' | 'staff' | 'barbero' | 'unas' | 'facial';

export interface LoginResponse {
  access: string;
  refresh?: string;
}

export interface MeResponse {
  id: number;
  name: string;
  role: UserRole;
}
