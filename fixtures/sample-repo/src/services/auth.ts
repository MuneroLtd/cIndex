import type { LoginRequest, LoginResponse } from "../types";
import { UserModel } from "../models/user";
import { SessionModel } from "../models/session";
import { generateId, hashPassword } from "../utils/helpers";

export class AuthService {
  private sessions: Map<string, SessionModel> = new Map();

  async login(request: LoginRequest): Promise<LoginResponse> {
    const user = await this.findUserByEmail(request.email);
    if (!user) {
      throw new Error("User not found");
    }

    const passwordMatch = await this.verifyPassword(request.password, user);
    if (!passwordMatch) {
      throw new Error("Invalid password");
    }

    const session = new SessionModel(
      generateId(),
      user.id,
      this.generateToken()
    );
    this.sessions.set(session.id, session);

    return { user: user.toJSON(), session };
  }

  async logout(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }

  validateSession(sessionId: string): SessionModel | null {
    const session = this.sessions.get(sessionId);
    if (!session || session.isExpired()) {
      return null;
    }
    return session;
  }

  private async findUserByEmail(email: string): Promise<UserModel | null> {
    // Stub: would query database
    return null;
  }

  private async verifyPassword(password: string, user: UserModel): Promise<boolean> {
    const hashed = hashPassword(password);
    return hashed === password; // Stub
  }

  private generateToken(): string {
    return Math.random().toString(36).substring(2);
  }
}
