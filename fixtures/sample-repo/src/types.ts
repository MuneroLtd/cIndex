export interface User {
  id: string;
  email: string;
  name: string;
  role: UserRole;
}

export type UserRole = "admin" | "user" | "guest";

export interface Session {
  id: string;
  userId: string;
  token: string;
  expiresAt: Date;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface LoginResponse {
  user: User;
  session: Session;
}
