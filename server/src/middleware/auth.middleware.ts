import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { prisma } from "../utils/prisma";
import { jwtSecret } from "../utils/config";

export interface AuthedRequest extends Request {
  user?: { id: number; name: string; email: string; role: "ADMIN" | "ACCOUNTANT" | "VIEWER" };
}

export function signToken(user: { id: number; role: string }): string {
  return jwt.sign({ id: user.id, role: user.role }, jwtSecret(), { expiresIn: "12h" });
}

export async function authenticate(req: AuthedRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Unauthorized", message: "Missing token" });
  try {
    const payload = jwt.verify(token, jwtSecret()) as { id: number; role: "ADMIN" | "ACCOUNTANT" | "VIEWER" };
    const u = await prisma.user.findUnique({ where: { id: payload.id } });
    if (!u) return res.status(401).json({ error: "Unauthorized", message: "User not found" });
    req.user = { id: u.id, name: u.name, email: u.email, role: u.role as "ADMIN" | "ACCOUNTANT" | "VIEWER" };
    next();
  } catch {
    return res.status(401).json({ error: "Unauthorized", message: "Invalid or expired token" });
  }
}

export function authorize(...roles: ("ADMIN" | "ACCOUNTANT" | "VIEWER")[]) {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: "Forbidden", message: "Insufficient permissions" });
    }
    next();
  };
}
