import { test } from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import { parseExcel, parseGstr2BJson, parseGstr1Json } from "../src/services/parsers.service";

function excelBuffer(rows: object[]): Buffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), "Sheet1");
  return XLSX.write(wb, { type: "buffer" }) as Buffer;
}

test("parseExcel preserves Excel date cells as real dates (no US M/D/YY month/day swap)", () => {
  // "Invoice Date" held as a genuine Excel date cell; a naive M/D/YY string
  // read (raw:false) would turn Jan 3 into Mar 1.
  const rows = [
    { GSTIN: "27ABCDE1234F1Z5", "Vendor Name": "Acme", "Invoice Number": "ACME-001", "Invoice Date": new Date(Date.UTC(2026, 0, 3)), "Taxable Value": 100000, CGST: 9000, SGST: 9000, IGST: 0 },
    { GSTIN: "29XYZAB5678C1Z2", "Vendor Name": "Globex", "Invoice Number": "GLBX-100", "Invoice Date": new Date(Date.UTC(2026, 1, 5)), "Taxable Value": 75000, CGST: 0, SGST: 0, IGST: 13500 },
  ];
  const parsed = parseExcel(excelBuffer(rows));
  const acme = parsed.find((r) => r.invoiceNo === "ACME-001")!;
  const globex = parsed.find((r) => r.invoiceNo === "GLBX-100")!;
  // Date is in the same UTC month we wrote, not a swapped month/day.
  assert.equal(acme.invoiceDate.getUTCMonth(), 0); // January
  assert.equal(acme.invoiceDate.getUTCDate(), 3);
  assert.equal(globex.invoiceDate.getUTCMonth(), 1); // February
  assert.equal(globex.invoiceDate.getUTCDate(), 5);
});

test("parseExcel reads CESS column and document type into ParsedRow", () => {
  const rows = [
    { GSTIN: "27ABCDE1234F1Z5", "Vendor Name": "Acme", "Invoice Number": "ACME-CESS", "Invoice Date": new Date(Date.UTC(2026, 0, 3)), "Taxable Value": 12000, CGST: 900, SGST: 900, IGST: 0, "Cess Amount": 1000, "Document Type": "C" },
  ];
  const parsed = parseExcel(excelBuffer(rows));
  assert.equal(parsed[0].cess, 1000);
  assert.equal(parsed[0].noteType, "CREDIT_NOTE");
});

test("parseGstr2BJson sums multi-line items, CESS and assigns notes", () => {
  const twoB = {
    data: {
      b2b: [
        { ctin: "27ABCDE1234F1Z5", trdnm: "Acme", in: [
          { inum: "ACME-MULTI", dt: "2026-01-15", itms: [
            { itm_det: { txval: 6000, camt: 450, samt: 450, iamt: 0, csamt: 500 } },
            { itm_det: { txval: 6000, camt: 450, samt: 450, iamt: 0, csamt: 500 } },
          ] },
        ]},
      ],
      cdnur: [
        { ctin: "27ABCDE1234F1Z5", trdnm: "Acme", nt: [
          { ntty: "C", nt_num: "CN-ACME-001", nt_dt: "2026-04-09", inum: "ACME-001", itms: [{ itm_det: { txval: 10000, camt: 900, samt: 900, iamt: 0 } }] },
        ]},
      ],
    },
  };
  const parsed = parseGstr2BJson(Buffer.from(JSON.stringify(twoB)));
  const multi = parsed.find((r) => r.invoiceNo === "ACME-MULTI")!;
  assert.equal(multi.taxableValue, 12000); // 6000+6000 summed
  assert.equal(multi.cgst, 900);
  assert.equal(multi.cess, 1000);          // 500+500 summed
  const note = parsed.find((r) => r.invoiceNo === "CN-ACME-001")!;
  assert.equal(note.noteType, "CREDIT_NOTE");
  assert.equal(note.cess, 0);
});

test("parseGstr1Json reads the real GSTR-1 'inv' array (not 'in') and cdnr notes", () => {
  // Real GST portal GSTR-1 files place every buyer's invoices under `inv` and
  // registered credit/debit notes under `cdnr` — not the GSTR-2B `in`/`cdn`.
  const gstr1 = {
    gstin: "27ACGFA8244G1ZC",
    fp: "072026",
    b2b: [
      { ctin: "27AAKCT4087D1Z4", cfs: "N", inv: [
        { val: 124601, itms: [{ itm_det: { txval: 118667.4, camt: 2966.69, samt: 2966.69, iamt: 0, csamt: 0 } }], inv_typ: "R", idt: "09-07-2026", inum: "ACO/26-27/13" },
      ]},
    ],
    cdnr: [
      { ctin: "27AAKCT4087D1Z4", nt: [
        { ntty: "C", nt_num: "CN-ACO-01", nt_dt: "20-07-2026", inum: "ACO/26-27/13", itms: [{ itm_det: { txval: 5000, camt: 450, samt: 450, iamt: 0 } }] },
      ]},
    ],
  };
  const parsed = parseGstr1Json(Buffer.from(JSON.stringify(gstr1)));
  const inv = parsed.find((r) => r.invoiceNo === "ACO/26-27/13")!;
  assert.equal(inv.invoiceNo, "ACO/26-27/13");
  assert.equal(parsed.find((r) => r.invoiceNo === "ACO/26-27/13")!.taxableValue, 118667.4);
  assert.equal(parsed.find((r) => r.invoiceNo === "ACO/26-27/13")!.invoiceValue, 124601); // portal `val`
  // The own (filing) company GSTIN from the top level is threaded through.
  assert.equal(inv.ownGstin, "27ACGFA8244G1ZC");
  const note = parsed.find((r) => r.invoiceNo === "CN-ACO-01")!;
  assert.equal(note.noteType, "CREDIT_NOTE");
  assert.equal(note.taxableValue, 5000);
});