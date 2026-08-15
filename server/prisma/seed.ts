// Seed script: creates demo users and a Purchase Register + GSTR-2B sample that
// exercises every reconciliation rule (matched, missing, mismatched, duplicate,
// wrong GSTIN/date/tax/taxable).
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  console.log("Seeding users...");
  const pwd = {
    admin: await bcrypt.hash("admin123", 10),
    acc:   await bcrypt.hash("acc123", 10),
    view:  await bcrypt.hash("view123", 10),
  };
  const users = [
    { name: "Admin",      email: "admin@gst.ai",      password: pwd.admin, role: "ADMIN" },
    { name: "Accountant", email: "accountant@gst.ai",  password: pwd.acc,   role: "ACCOUNTANT" },
    { name: "Viewer",      email: "viewer@gst.ai",     password: pwd.view,  role: "VIEWER" },
  ] as const;
  for (const u of users) {
    await prisma.user.upsert({ where: { email: u.email }, update: {}, create: { ...u } as any });
  }

  console.log("Seeding Purchase Register and GSTR-2B...");
  await prisma.invoice.deleteMany({});

  const V1 = "27ABCDE1234F1Z5"; // Acme
  const V2 = "29XYZAB5678C1Z2"; // Globex
  const V3 = "07MNOPQ9012R1Z9"; // Initech
  const V4 = "27AAAAA0000A1Z5"; // wrong-GSTIN supplier

  const baseY = new Date().getFullYear();
  const mkDate = (m: number, d: number) => new Date(baseY, m, d);

  // Each row represents one Books invoice.
  type Row = {
    source: string; gstin: string; vendorName: string; invoiceNo: string;
    invoiceDate: Date; taxableValue: number; cgst: number; sgst: number; igst: number;
  };

  const books: Row[] = [
    // --- matched: V1 Acme
    { source: "PURCHASE", gstin: V1, vendorName: "Acme Pvt Ltd", invoiceNo: "ACME-001", invoiceDate: mkDate(0, 3), taxableValue: 100000, cgst: 9000, sgst: 9000, igst: 0 },
    { source: "PURCHASE", gstin: V1, vendorName: "Acme Pvt Ltd", invoiceNo: "ACME-002", invoiceDate: mkDate(0, 7), taxableValue: 50000,  cgst: 4500, sgst: 4500, igst: 0 },
    // --- mismatched: wrong tax
    { source: "PURCHASE", gstin: V1, vendorName: "Acme Pvt Ltd", invoiceNo: "ACME-003", invoiceDate: mkDate(0, 12), taxableValue: 200000, cgst: 18000, sgst: 18000, igst: 0 },
    // --- missing in 2B: only in books
    { source: "PURCHASE", gstin: V2, vendorName: "Globex Ltd", invoiceNo: "GLBX-100", invoiceDate: mkDate(1, 5), taxableValue: 75000, cgst: 0, sgst: 0, igst: 13500 },
    // --- duplicate inside books
    { source: "PURCHASE", gstin: V2, vendorName: "Globex Ltd", invoiceNo: "GLBX-101", invoiceDate: mkDate(1, 9), taxableValue: 30000, cgst: 0, sgst: 0, igst: 5400 },
    { source: "PURCHASE", gstin: V2, vendorName: "Globex Ltd", invoiceNo: "GLBX-101", invoiceDate: mkDate(1, 9), taxableValue: 30000, cgst: 0, sgst: 0, igst: 5400 },
    // --- wrong GSTIN book vs 2B
    { source: "PURCHASE", gstin: V4, vendorName: "Wrong GSTIN Books", invoiceNo: "WRONG-001", invoiceDate: mkDate(2, 4), taxableValue: 60000, cgst: 0, sgst: 0, igst: 10800 },
    // --- wrong invoice date
    { source: "PURCHASE", gstin: V3, vendorName: "Initech Ltd", invoiceNo: "INTC-050", invoiceDate: mkDate(2, 1), taxableValue: 90000, cgst: 8100, sgst: 8100, igst: 0 },
    // --- wrong taxable value
    { source: "PURCHASE", gstin: V3, vendorName: "Initech Ltd", invoiceNo: "INTC-051", invoiceDate: mkDate(2, 8), taxableValue: 100000, cgst: 9000, sgst: 9000, igst: 0 },
  ];

  const twoB: Row[] = [
    { source: "GSTR2B", gstin: V1, vendorName: "Acme Pvt Ltd", invoiceNo: "ACME-001", invoiceDate: mkDate(0, 3), taxableValue: 100000, cgst: 9000, sgst: 9000, igst: 0 },
    { source: "GSTR2B", gstin: V1, vendorName: "Acme Pvt Ltd", invoiceNo: "ACME-002", invoiceDate: mkDate(0, 7), taxableValue: 50000,  cgst: 4500, sgst: 4500, igst: 0 },
    // ACME-003 in 2B with wrong tax (5% less)
    { source: "GSTR2B", gstin: V1, vendorName: "Acme Pvt Ltd", invoiceNo: "ACME-003", invoiceDate: mkDate(0, 12), taxableValue: 200000, cgst: 17000, sgst: 17000, igst: 0 },
    // WRONG-001 in 2B but under correct GSTIN (cross-check WRONG_GSTIN)
    { source: "GSTR2B", gstin: "27BBBBB1111B1Z5", vendorName: "Right GSTIN 2B", invoiceNo: "WRONG-001", invoiceDate: mkDate(2, 4), taxableValue: 60000, cgst: 0, sgst: 0, igst: 10800 },
    // INTC-050 with wrong date
    { source: "GSTR2B", gstin: V3, vendorName: "Initech Ltd", invoiceNo: "INTC-050", invoiceDate: mkDate(2, 16), taxableValue: 90000, cgst: 8100, sgst: 8100, igst: 0 },
    // INTC-051 with wrong taxable
    { source: "GSTR2B", gstin: V3, vendorName: "Initech Ltd", invoiceNo: "INTC-051", invoiceDate: mkDate(2, 8), taxableValue: 99000, cgst: 8910, sgst: 8910, igst: 0 },
    // Missing in Books: only in 2B
    { source: "GSTR2B", gstin: V3, vendorName: "Initech Ltd", invoiceNo: "INTC-999", invoiceDate: mkDate(2, 20), taxableValue: 120000, cgst: 10800, sgst: 10800, igst: 0 },
  ];

  await prisma.invoice.createMany({ data: [...books, ...twoB] as any });
  console.log(`Seeded ${books.length} books rows, ${twoB.length} 2B rows`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
