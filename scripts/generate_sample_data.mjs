// Generates realistic sample files in scripts/output to upload from the UI.
// Run:  node scripts/generate_sample_data.mjs
import XLSX from "xlsx";
import fs from "node:fs";
import path from "node:path";

const outDir = path.resolve("output");
fs.mkdirSync(outDir, { recursive: true });

const V1 = "27ABCDE1234F1Z5";
const V2 = "29XYZAB5678C1Z2";
const V3 = "07MNOPQ9012R1Z9";

const Y = new Date().getFullYear();
const m = (mon, d) => new Date(Y, mon, d);

const purchase = [
  { GSTIN: V1, "Vendor Name": "Acme Pvt Ltd", "Invoice Number": "ACME-001", "Invoice Date": m(0, 3), "Taxable Value": 100000, CGST: 9000, SGST: 9000, IGST: 0 },
  { GSTIN: V1, "Vendor Name": "Acme Pvt Ltd", "Invoice Number": "ACME-002", "Invoice Date": m(0, 7), "Taxable Value": 50000, CGST: 4500, SGST: 4500, IGST: 0 },
  { GSTIN: V1, "Vendor Name": "Acme Pvt Ltd", "Invoice Number": "ACME-003", "Invoice Date": m(0, 12), "Taxable Value": 200000, CGST: 18000, SGST: 18000, IGST: 0 },
  { GSTIN: V2, "Vendor Name": "Globex Ltd", "Invoice Number": "GLBX-100", "Invoice Date": m(1, 5), "Taxable Value": 75000, CGST: 0, SGST: 0, IGST: 13500 },
  { GSTIN: V2, "Vendor Name": "Globex Ltd", "Invoice Number": "GLBX-101", "Invoice Date": m(1, 9), "Taxable Value": 30000, CGST: 0, SGST: 0, IGST: 5400 },
  { GSTIN: V2, "Vendor Name": "Globex Ltd", "Invoice Number": "GLBX-101", "Invoice Date": m(1, 9), "Taxable Value": 30000, CGST: 0, SGST: 0, IGST: 5400 }, // duplicate
  { GSTIN: "27AAAAA0000A1Z5", "Vendor Name": "Wrong GSTIN Books", "Invoice Number": "WRONG-001", "Invoice Date": m(2, 4), "Taxable Value": 60000, CGST: 0, SGST: 0, IGST: 10800 },
  { GSTIN: V3, "Vendor Name": "Initech Ltd", "Invoice Number": "INTC-050", "Invoice Date": m(2, 1), "Taxable Value": 90000, CGST: 8100, SGST: 8100, IGST: 0 },
  { GSTIN: V3, "Vendor Name": "Initech Ltd", "Invoice Number": "INTC-051", "Invoice Date": m(2, 8), "Taxable Value": 100000, CGST: 9000, SGST: 9000, IGST: 0 },
];

const sales = purchase.map((p, i) => ({
  GSTIN: "27ZZZZZ9999Z1Z5",
  "Vendor Name": "Customer Pvt Ltd",
  "Invoice Number": `SALE-${String(i + 1).padStart(3, "0")}`,
  "Invoice Date": p["Invoice Date"],
  "Taxable Value": p["Taxable Value"] * 1.2,
  CGST: p.CGST * 1.2, SGST: p.SGST * 1.2, IGST: p.IGST * 1.2,
}));

const twoB = {
  data: { b2b: [
    { ctin: V1, in: [{ inum: "ACME-001", dt: m(0, 3), itms: [{ itm_det: { txval: 100000, camt: 9000, samt: 9000, iamt: 0 } }] },
                    { inum: "ACME-002", dt: m(0, 7), itms: [{ itm_det: { txval: 50000,  camt: 4500, samt: 4500, iamt: 0 } }] },
                    { inum: "ACME-003", dt: m(0,12), itms: [{ itm_det: { txval: 200000, camt: 17000, samt: 17000, iamt: 0 } }] } ]},
    { ctin: "27BBBBB1111B1Z5", in: [{ inum: "WRONG-001", dt: m(2, 4), itms: [{ itm_det: { txval: 60000, camt: 0, samt: 0, iamt: 10800 } }] } ]},
    { ctin: V3, in: [{ inum: "INTC-050", dt: m(2,16), itms: [{ itm_det: { txval: 90000, camt: 8100, samt: 8100, iamt: 0 } }] },
                    { inum: "INTC-051", dt: m(2,8),  itms: [{ itm_det: { txval: 99000, camt: 8910, samt: 8910, iamt: 0 } }] },
                    { inum: "INTC-999", dt: m(2,20), itms: [{ itm_det: { txval: 120000, camt: 10800, samt: 10800, iamt: 0 } }] } ]},
  ] },
};

const gstr1 = {
  b2b: [
    { ctin: "27ZZZZZ9999Z1Z5", in: sales.map((s) => ({ inum: s["Invoice Number"], dt: s["Invoice Date"], itms: [{ itm_det: { txval: s["Taxable Value"], camt: s.CGST, samt: s.SGST, iamt: s.IGST } }] })) },
  ],
};

const gstr3b = [
  { Month: "April", TotalTaxable: sales.reduce((a, b) => a + b["Taxable Value"], 0),
    CGST: sales.reduce((a, b) => a + b.CGST, 0), SGST: sales.reduce((a, b) => a + b.SGST, 0), IGST: sales.reduce((a, b) => a + b.IGST, 0) },
];

function writeSheet(rows, name) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), name);
  XLSX.writeFile(wb, path.join(outDir, `${name}.xlsx`));
}
writeSheet(purchase, "purchase_register");
writeSheet(sales,     "sales_register");
writeSheet(gstr3b,    "gstr3b");
fs.writeFileSync(path.join(outDir, "gstr2b.json"), JSON.stringify(twoB,   null, 2));
fs.writeFileSync(path.join(outDir, "gstr1.json"),  JSON.stringify(gstr1,  null, 2));
console.log(`Generated sample files in ${outDir}`);
