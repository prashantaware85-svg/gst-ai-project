import { Router } from "express";
import bcrypt from "bcryptjs";
import { prisma } from "../utils/prisma";
import { signToken, authenticate, authorize, AuthedRequest } from "../middleware/auth.middleware";
import { rateLimit } from "../middleware/rate-limit.middleware";
import { z } from "zod";

export const authRouter = Router();

const loginLimiter = rateLimit({ windowMs: 60_000, max: 10, message: "Too many login attempts. Try again shortly." });
const userCreateLimiter = rateLimit({ windowMs: 60_000, max: 20, message: "Too many user creation attempts." });

async function issueTokenFor(userId: number) {
  const u = await prisma.user.findUnique({ where: { id: userId } });
  if (!u) return null;
  const token = signToken({ id: u.id, role: u.role });
  return { token, user: { id: u.id, name: u.name, email: u.email, role: u.role } };
}

const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });

authRouter.post("/auth/login", loginLimiter, async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "BadRequest", message: parsed.error.flatten() });
  const { email, password } = parsed.data;
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return res.status(401).json({ error: "Unauthorized", message: "Invalid email or password" });
  const ok = await bcrypt.compare(password, user.password);
  if (!ok) return res.status(401).json({ error: "Unauthorized", message: "Invalid email or password" });
  const t = await issueTokenFor(user.id);
  return res.json(t);
});

authRouter.get("/auth/me", authenticate, (req: AuthedRequest, res) => {
  return res.json({ user: req.user });
});

const signupSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(6),
  role: z.enum(["ADMIN", "ACCOUNTANT", "VIEWER"]).default("VIEWER"),
});

authRouter.post("/auth/users", userCreateLimiter, authenticate, authorize("ADMIN"), async (req, res) => {
  const parsed = signupSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "BadRequest", message: parsed.error.flatten() });
  const { name, email, password, role } = parsed.data;
  const exists = await prisma.user.findUnique({ where: { email } });
  if (exists) return res.status(409).json({ error: "Conflict", message: "Email already registered" });
  const hash = await bcrypt.hash(password, 10);
  const u = await prisma.user.create({ data: { name, email, password: hash, role } });
  return res.status(201).json({ id: u.id, name: u.name, email: u.email, role: u.role });
});

authRouter.get("/auth/users", authenticate, authorize("ADMIN"), async (_req, res) => {
  const users = await prisma.user.findMany({ select: { id: true, name: true, email: true, role: true, createdAt: true } });
  return res.json({ users });
});
