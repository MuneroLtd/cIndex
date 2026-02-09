import type { Session } from "../types";
import { BaseModel } from "./user";

export class SessionModel extends BaseModel implements Session {
  userId: string;
  token: string;
  expiresAt: Date;

  constructor(id: string, userId: string, token: string) {
    super(id);
    this.userId = userId;
    this.token = token;
    this.expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  }

  isExpired(): boolean {
    return new Date() > this.expiresAt;
  }

  refresh(): void {
    this.expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    this.save();
  }
}
