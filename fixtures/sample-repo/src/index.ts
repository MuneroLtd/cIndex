import { AuthService, UserService } from "./services";
import { AuthController } from "./controllers/auth-controller";
import type { User } from "./types";

export function createApp() {
  const authService = new AuthService();
  const userService = new UserService();
  const authController = new AuthController();

  return {
    authService,
    userService,
    authController,
  };
}

export type { User };
