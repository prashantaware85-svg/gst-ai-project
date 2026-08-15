# Sample Data

The project includes a one-command seed (`npm run seed` inside `server/`) that creates:

- 3 demo users (admin, accountant, viewer)
- A 6-month Purchase Register (xlsx) + GSTR-2B (json)
- Intentionally injected mismatches covering every rule the AI engine can detect:

| Mismatch type | How it's injected |
|---------------|------------------|
| Missing in 2B      | One vendor row exists only in Purchase Register |
| Missing in Books   | One invoice exists only in GSTR-2B |
| Duplicate Invoice  | Same invoice number twice under same GSTIN (taxable differs) |
| Wrong GSTIN        | Books GSTIN `27ABCDE1234F1Z5` vs 2B `27XXXXX9999Q1Z5` |
| Wrong Tax Amount   | IGST 5% mismatch on one row |
| Wrong Invoice Date | -15-day offset |
| Wrong Taxable Value| 2B taxable ₹101,000 vs books ₹100,000 |

Generate additional scripted data with:

```bash
cd scripts
node generate_sample_data.mjs
```
Emits to `scripts/output/`:
- `purchase_register.xlsx`
- `sales_register.xlsx`
- `gstr2b.json`
- `gstr1.json`
- `gstr3b.xlsx`

Upload those from the UI to test the end-to-end flow.
