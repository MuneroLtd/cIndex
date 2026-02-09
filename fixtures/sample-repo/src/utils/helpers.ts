export function generateId(): string {
  return Math.random().toString(36).substring(2, 15);
}

export function hashPassword(password: string): string {
  // Stub: would use bcrypt
  return password;
}

export function formatDate(date: Date): string {
  return date.toISOString();
}

export const APP_NAME = "sample-app";
export const MAX_SESSION_AGE = 86400;
