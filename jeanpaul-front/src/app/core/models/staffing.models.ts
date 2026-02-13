export type WorkerRole = 'BARBER' | 'NAILS' | 'FACIAL';

export interface WorkerManage {
  id: number;
  display_name: string;
  role: WorkerRole;
  active: boolean;

  // vienen del serializer
  user_id?: number | null;
  username?: string;
  email?: string;
  phone?: string;
}

export interface WorkerScheduleRule {
  id: number;
  worker: number;
  day_of_week: number; // 0..6
  start_time: string;  // "HH:MM:SS" o "HH:MM"
  end_time: string;
  active: boolean;
}

export interface WorkerBreak {
  id: number;
  worker: number;
  day_of_week: number;
  start_time: string;
  end_time: string;
}

export type WorkerExceptionType = 'TIME_OFF' | 'EXTRA_WORKING';

export interface WorkerException {
  id: number;
  worker: number;
  date: string; // "YYYY-MM-DD"
  type: WorkerExceptionType;
  start_time: string | null;
  end_time: string | null;
  note: string;
}
