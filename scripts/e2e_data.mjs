// E2E test-data generator. Produces realistic GST upload files in temp dir:
//   purchase_register.csv  / purchase_register_large.xlsx  (Purchase Register)
//   sales_register.csv     / sales_register_large.xlsx     (Sales Register)
//   gstr2b.json            (GSTR-2B incl. b2ba + cdnur credit notes + CESS)
//   gstr1.json             (GSTR-1 incl. cdn debit/credit notes)
// Run:  node e2e_data.mjs <outdir>
import XLSX from "xlsx";
import fs from "node:fs";
import path from "node:path";

const outDir = process.argv[2] || ".";
fs.mkdirSync(outDir, { recursive: true });

const V1 = "27ABCDE1234F1Z5";
const V2 = "29XYZAB5678C1Z2";
const V3 = "07MNOPQ9012R1Z9";
const V4 = "27AAAAA0000A1Z5";
const V5 = "28PQRST0000P1Z9";
const YEAR = 2026;
const m = (mon, d) => new Date(Date.UTC(YEAR, mon, d));
const iso = (d) => d.toISOString();

// ---------------- Purchase Register (books) ----------------
// Includes: matched, wrong-tax, wrong-date, wrong-GSTIN, duplicate,
// credit note (negative), debit note, CESS invoice, multi-line items handled in 2B.
const purchase = [
  { GSTIN: V1, "Vendor Name": "Acme Pvt Ltd", "Invoice Number": "ACME-001", "Invoice Date": m(0, 3), "Taxable Value": 100000, CGST: 9000, SGST: 9000, IGST: 0 },
  { GSTIN: V1, "Vendor Name": "Acme Pvt Ltd", "Invoice Number": "ACME-002", "Invoice Date": m(0, 7), "Taxable Value": 50000, CGST: 4500, SGST: 4500, IGST: 0 },
  { GSTIN: V1, "Vendor Name": "Acme Pvt Ltd", "Invoice Number": "ACME-003", "Invoice Date": m(0, 12), "Taxable Value": 200000, CGST: 18000, SGST: 18000, IGST: 0 },
  { GSTIN: V1, "Vendor Name": "Acme Pvt Ltd", "Invoice Number": "ACME-004", "Invoice Date": m(0, 15), "Taxable Value": 12000, CGST: 900, SGST: 900, IGST: 0, CESS: 1000 },
  { GSTIN: V2, "Vendor Name": "Globex Ltd", "Invoice Number": "GLBX-100", "Invoice Date": m(1, 5), "Taxable Value": 75000, CGST: 0, SGST: 0, IGST: 13500 },
  { GSTIN: V2, "Vendor Name": "Globex Ltd", "Invoice Number": "GLBX-101", "Invoice Date": m(1, 9), "Taxable Value": 30000, CGST: 0, SGST: 0, IGST: 5400 },
  { GSTIN: V2, "Vendor Name": "Globex Ltd", "Invoice Number": "GLBX-101", "Invoice Date": m(1, 9), "Taxable Value": 30000, CGST: 0, SGST: 0, IGST: 5400 },
  { GSTIN: V4, "Vendor Name": "Wrong GSTIN Books", "Invoice Number": "WRONG-001", "Invoice Date": m(2, 4), "Taxable Value": 60000, CGST: 0, SGST: 0, IGST: 10800 },
  { GSTIN: V3, "Vendor Name": "Initech Ltd", "Invoice Number": "INTC-050", "Invoice Date": m(2, 1), "Taxable Value": 90000, CGST: 8100, SGST: 8100, IGST: 0 },
  { GSTIN: V3, "Vendor Name": "Initech Ltd", "Invoice Number": "INTC-051", "Invoice Date": m(2, 8), "Taxable Value": 100000, CGST: 9000, SGST: 9000, IGST: 0 },
  { GSTIN: V5, "Vendor Name": "Invotech Pta", "Invoice Number": "FZEB-001", "Invoice Date": m(2, 22), "Taxable Value": 150000, CGST: 0, SGST: 0, IGST: 27000 },
  // Credit note in books (negative amounts per register convention)
  { GSTIN: V1, "Vendor Name": "Acme Pvt Ltd", "Invoice Number": "CN-ACME-001", "Invoice Date": m(3, 9), "Taxable Value": -10000, CGST: -900, SGST: -900, IGST: 0, "Document Type": "C" },
  // Debit note in books
  { GSTIN: V2, "Vendor Name": "Globex Ltd", "Invoice Number": "DN-GLBX-100", "Invoice Date": m(3, 12), "Taxable Value": 5000, CGST: 0, SGST: 0, IGST: 900, "Document Type": "D" },
];
const purchaseCSV = purchase.map((r) => ({
  GSTIN: r.GSTIN,
  "Vendor Name": r["Vendor Name"],
  "Invoice Number": r["Invoice Number"],
  "Invoice Date": `${r["Invoice Date"].getFullYear()}-${String(r["Invoice Date"].getMonth() + 1).padStart(2, "0")}-${String(r["Invoice Date"].getDate()).padStart(2, "0")}`,
  "Taxable Value": r["Taxable Value"],
  CGST: r.CGST,
  SGST: r.SGST,
  IGST: r.IGST,
  CESS: r.CESS || 0,
  "Document Type": r["Document Type"] || "R",
}));

// ---------------- Sales Register ----------------
const sales = [
  { GSTIN: "27ZZZZZ9999Z1Z5", "Vendor Name": "Customer A Ltd", "Invoice Number": "SALE-001", "Invoice Date": m(0, 4), "Taxable Value": 120000, CGST: 10800, SGST: 10800, IGST: 0 },
  { GSTIN: "27ZZZZZ9999Z1Z5", "Vendor Name": "Customer B Pvt", "Invoice Number": "SALE-002", "Invoice Date": m(0, 9), "Taxable Value": 60000, CGST: 5400, SGST: 5400, IGST: 0 },
  { GSTIN: "27ZZZZZ9999Z1Z5", "Vendor Name": "Customer C Ltd", "Invoice Number": "SALE-003", "Invoice Date": m(1, 3), "Taxable Value": 240000, CGST: 21600, SGST: 21600, IGST: 0 },
];
const salesCSV = sales.map((r) => ({
  GSTIN: r.GSTIN,
  "Vendor Name": r["Vendor Name"],
  "Invoice Number": r["Invoice Number"],
  "Invoice Date": `${r["Invoice Date"].getFullYear()}-${String(r["Invoice Date"].getMonth() + 1).padStart(2, "0")}-${String(r["Invoice Date"].getDate()).padStart(2, "0")}`,
  "Taxable Value": r["Taxable Value"],
  CGST: r.CGST,
  SGST: r.SGST,
  IGST: r.IGST,
})).concat([
  // one missing, one mismatched taxable in GSTR-1
  { GSTIN: "27ZZZZZ9999Z1Z5", "Vendor Name": "Customer D", "Invoice Number": "SALE-004", "Invoice Date": m(1, 10), "Taxable Value": 90000, CGST: 8100, SGST: 8100, IGST: 0 },
]);

// ---------------- GSTR-2B ----------------
const twoB = {
  data: {
    b2b: [
      { ctin: V1, trdnm: "Acme Pvt Ltd", in: [
        { inum: "ACME-001", dt: iso(m(0, 3)), itms: [{ itm_det: { txval: 100000, camt: 9000, samt: 9000, iamt: 0, csamt: 0 } }] },
        { inum: "ACME-002", dt: iso(m(0, 7)), itms: [{ itm_det: { txval: 50000, camt: 4500, samt: 4500, iamt: 0, csamt: 0 } }] },
        { inum: "ACME-003", dt: iso(m(0, 12)), itms: [{ itm_det: { txval: 200000, camt: 17000, samt: 17000, iamt: 0, csamt: 0 } }] },
        // multi-line item invoice with CESS - totals only visible when summed
        { inum: "ACME-004", dt: iso(m(0, 15)), itms: [
          { itm_det: { txval: 6000, camt: 450, samt: 450, iamt: 0, csamt: 500 } },
          { itm_det: { txval: 6000, camt: 450, samt: 450, iamt: 0, csamt: 500 } },
        ] },
      ]},
      { ctin: "27BBBBB1111B1Z5", trdnm: "Right GSTIN 2B", in: [
        { inum: "WRONG-001", dt: iso(m(2, 4)), itms: [{ itm_det: { txval: 60000, camt: 0, samt: 0, iamt: 10800, csamt: 0 } }] },
      ]},
      { ctin: V3, trdnm: "Initech Ltd", in: [
        { inum: "INTC-050", dt: iso(m(2, 16)), itms: [{ itm_det: { txval: 90000, camt: 8100, samt: 8100, iamt: 0, csamt: 0 } }] },
        { inum: "INTC-051", dt: iso(m(2, 8)), itms: [{ itm_det: { txval: 99000, camt: 8910, samt: 8910, iamt: 0, csamt: 0 } }] },
        { inum: "INTC-999", dt: iso(m(2, 20)), itms: [{ itm_det: { txval: 120000, camt: 10800, samt: 10800, iamt: 0, csamt: 0 } }] },
      ]},
      { ctin: V5, trdnm: "Invotech Pta", in: [
        { inum: "FZEB-001", dt: iso(m(2, 22)), itms: [{ itm_det: { txval: 150000, camt: 0, samt: 0, iamt: 27000, csamt: 0 } }] },
      ]},
    ],
    // Credit/Debit notes (cdnur) - ntty C = credit, D = debit
    cdnur: [
      { ctin: V1, trdnm: "Acme Pvt Ltd", nt: [
        // Matches books credit note CN-ACME-001 (original invoice ACME-001)
        { ntty: "C", nt_num: "CN-ACME-001", nt_dt: iso(m(3, 9)), inum: "ACME-001", idt: iso(m(0, 3)), itms: [{ itm_det: { txval: 10000, camt: 900, samt: 900, iamt: 0, csamt: 0 } }] },
      ]},
      { ctin: V2, trdnm: "Globex Ltd", nt: [
        // Debit note for Globex (matches books DN-GLBX-100)
        { ntty: "D", nt_num: "DN-GLBX-100", nt_dt: iso(m(3, 12)), inum: "GLBX-100", idt: iso(m(1, 5)), itms: [{ itm_det: { txval: 5000, camt: 0, samt: 0, iamt: 900, csamt: 0 } }] },
      ]},
    ],
  },
};

// ---------------- GSTR-1 ----------------
const gstr1 = {
  b2b: [
    { ctin: "27ZZZZZ9999Z1Z5", trdnm: "Our Company", in: [
      { inum: "SALE-001", dt: iso(m(0, 4)), itms: [{ itm_det: { txval: 120000, camt: 10800, samt: 10800, iamt: 0 } }] },
      { inum: "SALE-002", dt: iso(m(0, 9)), itms: [{ itm_det: { txval: 61000, camt: 5400, samt: 5400, iamt: 0 } }] },
      { inum: "SALE-003", dt: iso(m(1, 3)), itms: [{ itm_det: { txval: 240000, camt: 21600, samt: 21600, iamt: 0 } }] },
    ]},
  ],
  cdn: [
    { ctin: "27ZZZZZ9999Z1Z5", trdnm: "Our Company", nt: [
      { ntty: "C", nt_num: "CN-SALE-001", nt_dt: iso(m(4, 2)), inum: "SALE-001", itms: [{ itm_det: { txval: 5000, camt: 450, samt: 450, iamt: 0 } }] },
    ]},
  ],
};

// ---------------- Large dataset ----------------
// 3000 purchases + 3000 sales, all matching, to test throughput + report paging.
const big = [];
const bigSales = [];
for (let i = 1; i <= 3000; i++) {
  const tv = 1000 + (i % 900) * 100;
  const cg = Math.round(tv * 0.09);
  big.push({ GSTIN: V1, "Vendor Name": "Acme Pvt Ltd", "Invoice Number": `BIG-${String(i).padStart(6, "0")}`, "Invoice Date": m(0, i % 28), "Taxable Value": tv, CGST: cg, SGST: cg, IGST: 0 });
  bigSales.push({ GSTIN: "27ZZZZZ9999Z1Z5", "Vendor Name": "Customer Bulk", "Invoice Number": `BSALE-${String(i).padStart(6, "0")}`, "Invoice Date": m(0, i % 28), "Taxable Value": tv, CGST: cg, SGST: cg, IGST: 0 });
  if (i % 150 === 0) big.push({ GSTIN: V1, "Vendor Name": "Acme Pvt Ltd", "Invoice Number": `BIG-${String(i).padStart(6, "0")}`, "Invoice Date": m(0, i % 28), "Taxable Value": tv, CGST: cg, SGST: cg, IGST: 0 }); // duplicates
}
const bigTwoB = { data: { b2b: [] } };
for (let i = 1; i <= 3000; i++) {
  const tv = 1000 + (i % 900) * 100;
  const cg = Math.round(tv * 0.09);
  bigTwoB.data.b2b.push({ ctin: V1, trdnm: "Acme Pvt Ltd", in: [{ inum: `BIG-${String(i).padStart(6, "0")}`, dt: iso(m(0, i % 28)), itms: [{ itm_det: { txval: tv, camt: cg, samt: cg, iamt: 0, csamt: 0 } }] }] });
}

function writeSheet(rows, name) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), name);
  XLSX.writeFile(wb, path.join(outDir, `${name}.xlsx`));
}
function writeCSV(rows, name) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), "Sheet1");
  XLSX.writeFile(wb, path.join(outDir, name));
}
function writeJSON(obj, name) {
  fs.writeFileSync(path.join(outDir, name), JSON.stringify(obj));
}

writeSheet(purchase, "purchase_register");
writeSheet(sales, "sales_register");
writeCSV(purchaseCSV, "purchase_register.csv");
writeCSV(salesCSV, "sales_register.csv");
writeJSON(twoB, "gstr2b.json");
writeJSON(gstr1, "gstr1.json");
writeSheet(big, "purchase_large");
writeSheet(bigSales, "sales_large");
writeJSON(bigTwoB, "gstr2b_large.json");

console.log("Generated in", outDir);
console.log({ purchase: purchase.length, sales2: salesCSV.length, big: big.length, bigSales: bigSales.length, bigTwoB: bigTwoB.data.b2b.length });