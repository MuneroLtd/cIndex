import type { User, UserRole } from "../types";
import { UserModel } from "../models/user";
import { generateId } from "../utils/helpers";

export class UserService {
  private users: Map<string, UserModel> = new Map();

  createUser(email: string, name: string, role: UserRole = "user"): UserModel {
    const user = new UserModel(generateId(), email, name, role);
    this.users.set(user.id, user);
    return user;
  }

  getUserById(id: string): UserModel | undefined {
    return this.users.get(id);
  }

  listUsers(): User[] {
    return Array.from(this.users.values()).map((u) => u.toJSON());
  }

  deleteUser(id: string): boolean {
    return this.users.delete(id);
  }
}
