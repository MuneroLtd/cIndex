import type { User, UserRole } from "../types";

export class BaseModel {
  id: string;
  createdAt: Date;
  updatedAt: Date;

  constructor(id: string) {
    this.id = id;
    this.createdAt = new Date();
    this.updatedAt = new Date();
  }

  save(): void {
    this.updatedAt = new Date();
  }
}

export class UserModel extends BaseModel implements User {
  email: string;
  name: string;
  role: UserRole;

  constructor(id: string, email: string, name: string, role: UserRole = "user") {
    super(id);
    this.email = email;
    this.name = name;
    this.role = role;
  }

  isAdmin(): boolean {
    return this.role === "admin";
  }

  toJSON(): User {
    return {
      id: this.id,
      email: this.email,
      name: this.name,
      role: this.role,
    };
  }
}
