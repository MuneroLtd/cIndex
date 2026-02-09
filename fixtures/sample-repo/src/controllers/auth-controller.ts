import { AuthService } from "../services";
import type { LoginRequest } from "../types";

export class AuthController {
  private authService: AuthService;

  constructor() {
    this.authService = new AuthService();
  }

  async handleLogin(req: { body: LoginRequest }): Promise<{ status: number; data: unknown }> {
    try {
      const result = await this.authService.login(req.body);
      return { status: 200, data: result };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Login failed";
      return { status: 401, data: { error: message } };
    }
  }

  async handleLogout(req: { sessionId: string }): Promise<{ status: number }> {
    await this.authService.logout(req.sessionId);
    return { status: 204 };
  }
}
