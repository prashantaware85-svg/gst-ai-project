import { Router } from "express";
import { prisma } from "../utils/prisma";
import { authenticate, AuthedRequest, authorize } from "../middleware/auth.middleware";

export const notificationsRouter = Router();

notificationsRouter.get("/notifications", authenticate, async (req: AuthedRequest, res) => {
  const rows = await prisma.notification.findMany({
    where: { userId: req.user!.id },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  return res.json({ notifications: rows });
});

notificationsRouter.post("/notifications/:id/read", authenticate, async (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const n = await prisma.notification.findUnique({ where: { id } });
  if (!n) return res.status(404).json({ error: "NotFound" });
  if (n.userId !== req.user!.id && req.user!.role !== "ADMIN") return res.status(403).json({ error: "Forbidden" });
  await prisma.notification.update({ where: { id }, data: { read: true } });
  return res.json({ ok: true });
});
