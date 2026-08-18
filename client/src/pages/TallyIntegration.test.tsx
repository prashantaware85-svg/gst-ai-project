import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import TallyIntegration from "./TallyIntegration";
import { api } from "../api/client";
import { useAuth } from "../hooks/useAuth";

vi.mock("../api/client", () => ({
  api: {
    tallyStatus: vi.fn(),
    tallyCompany: vi.fn(),
    tallyVouchers: vi.fn(),
    tallyImport: vi.fn(),
    tallyImportSummary: vi.fn(),
    tallyImports: vi.fn(),
  },
}));

vi.mock("../hooks/useAuth", () => ({ useAuth: vi.fn() }));

const mockedApi = vi.mocked(api);
const mockedUseAuth = vi.mocked(useAuth);

const NOT_CONNECTED = "TallyPrime is not running or Tally XML/HTTP server is not enabled.";

const EMPTY_SUMMARY = {
  ok: true,
  total: 0,
  byVoucherType: { Sales: 0, Purchase: 0 },
  last: {
    Sales: { imported: 0, skipped: 0, failed: 0, count: 0 },
    Purchase: { imported: 0, skipped: 0, failed: 0, count: 0 },
  },
  runs: [],
};

function salesImportResult(over: Partial<Record<string, unknown>> = {}) {
  return {
    ok: true,
    voucherType: "Sales",
    imported: 2,
    skipped: 0,
    failed: 0,
    totals: {
      count: 2,
      taxableValue: 25856.9,
      cgst: 646.44,
      sgst: 646.44,
      igst: 0,
      roundOff: 0.22,
      totalAmount: 27150,
    },
    ...over,
  };
}

function renderPage() {
  return render(<TallyIntegration />);
}

describe("TallyIntegration", () => {
  beforeEach(() => {
    mockedUseAuth.mockReturnValue({
      user: { id: 1, name: "Admin", role: "ADMIN" },
      loading: false,
      login: vi.fn(),
      logout: vi.fn(),
    } as any);
    mockedApi.tallyImportSummary.mockResolvedValue(EMPTY_SUMMARY as any);
    mockedApi.tallyImports.mockResolvedValue({ ok: true, count: 0, rows: [] } as any);
    mockedApi.tallyCompany.mockReset();
    mockedApi.tallyStatus.mockReset();
    mockedApi.tallyImport.mockReset();
  });

  test("renders the connection page with a Connect button", () => {
    renderPage();
    expect(screen.getByText("Tally Integration")).toBeTruthy();
    expect(screen.getByText("Connect Tally")).toBeTruthy();
    expect(screen.getByText("Not Connected")).toBeTruthy();
  });

  test("connect success shows the company details", async () => {
    mockedApi.tallyCompany.mockResolvedValue({
      connected: true,
      companyName: "AGRICROP ORGANICS",
      gstin: null,
      message: "Company information retrieved",
    });
    renderPage();
    fireEvent.click(screen.getByText("Connect Tally"));
    expect(await screen.findByText("AGRICROP ORGANICS")).toBeTruthy();
    expect(screen.getByText("Connected")).toBeTruthy();
    expect(screen.getByText("http://localhost:9000")).toBeTruthy();
  });

  test("connect failure shows the friendly not-connected message", async () => {
    mockedApi.tallyCompany.mockResolvedValue({ connected: false, message: NOT_CONNECTED });
    renderPage();
    fireEvent.click(screen.getByText("Connect Tally"));
    expect(await screen.findByText(NOT_CONNECTED)).toBeTruthy();
  });

  test("sales import shows the imported totals from the API", async () => {
    mockedApi.tallyImport.mockResolvedValue(salesImportResult());
    renderPage();
    fireEvent.click(screen.getByText("Import Sales"));
    expect(await screen.findByText("Sales Imported")).toBeTruthy();
    expect(screen.getByText("₹25,856.90")).toBeTruthy();
    expect(screen.getAllByText("₹646.44").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("₹27,150.00")).toBeTruthy();
  });

  test("empty purchase response is shown as info, not an error", async () => {
    mockedApi.tallyImport.mockResolvedValue({
      ok: true,
      voucherType: "Purchase",
      imported: 0,
      skipped: 0,
      failed: 0,
      totals: { count: 0, taxableValue: 0, cgst: 0, sgst: 0, igst: 0, roundOff: 0, totalAmount: 0 },
    });
    renderPage();
    fireEvent.click(screen.getByText("Import Purchase"));
    expect(await screen.findByText("No Purchase vouchers found for the selected period.")).toBeTruthy();
  });

  test("duplicate sales import reports skipped duplicates", async () => {
    mockedApi.tallyImport.mockResolvedValue(
      salesImportResult({
        imported: 0,
        skipped: 2,
        totals: { count: 0, taxableValue: 0, cgst: 0, sgst: 0, igst: 0, roundOff: 0, totalAmount: 0 },
      }),
    );
    renderPage();
    fireEvent.click(screen.getByText("Import Sales"));
    expect(
      await screen.findByText("2 duplicate Sales voucher(s) already present; nothing new imported."),
    ).toBeTruthy();
  });

  test("fromDate after toDate is rejected without calling the import API", () => {
    renderPage();
    fireEvent.change(screen.getByLabelText("From Date"), { target: { value: "2027-03-31" } });
    fireEvent.change(screen.getByLabelText("To Date"), { target: { value: "2026-04-01" } });
    fireEvent.click(screen.getByText("Import Sales"));
    expect(screen.getByText("From Date must be on or before To Date.")).toBeTruthy();
    expect(mockedApi.tallyImport).not.toHaveBeenCalled();
  });

  test("import failure surfaces a friendly message", async () => {
    mockedApi.tallyImport.mockRejectedValue(new Error("Network Error"));
    renderPage();
    fireEvent.click(screen.getByText("Import Sales"));
    expect(await screen.findByText(NOT_CONNECTED)).toBeTruthy();
  });

  test("import summary panel shows totals from the summary API", async () => {
    mockedApi.tallyImportSummary.mockResolvedValue({
      ok: true,
      total: 2,
      byVoucherType: { Sales: 2, Purchase: 0 },
      last: {
        Sales: { imported: 2, skipped: 0, failed: 0, count: 2 },
        Purchase: { imported: 0, skipped: 0, failed: 0, count: 0 },
      },
      runs: [],
    } as any);
    renderPage();
    expect(await screen.findByText("Tally Import Summary")).toBeTruthy();
    expect(await screen.findByText("Total records in database: 2")).toBeTruthy();
  });
});
