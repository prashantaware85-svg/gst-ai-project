import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import Reconciliation from "./Reconciliation";
import { api } from "../api/client";
import { useAuth } from "../hooks/useAuth";

vi.mock("../api/client", () => ({
  api: {
    reconSummary: vi.fn(),
    reconResults: vi.fn(),
    reconRun: vi.fn(),
    reconReview: vi.fn(),
    reconExport: vi.fn(),
  },
}));

vi.mock("../hooks/useAuth", () => ({ useAuth: vi.fn() }));

const mockedApi = vi.mocked(api);
const mockedUseAuth = vi.mocked(useAuth);

function summary(over: Record<string, unknown> = {}) {
  return {
    success: true,
    runId: 3,
    period: "2026-08",
    transactionType: "SALES",
    totalTally: 2,
    totalGst: 3,
    matched: 1,
    amountMismatch: 0,
    dateMismatch: 0,
    invoiceNumberMismatch: 0,
    gstinMismatch: 0,
    missingInGst: 0,
    missingInTally: 1,
    duplicateInTally: 0,
    duplicateInGst: 0,
    possibleMatch: 1,
    invalidData: 0,
    ...over,
  };
}

function row(over: Record<string, unknown> = {}) {
  return {
    id: 1,
    runId: 3,
    status: "POSSIBLE_MATCH",
    matchLevel: "LEVEL4",
    confidence: 75,
    taxableDifference: 0,
    cgstDifference: 0,
    sgstDifference: 0,
    igstDifference: 0,
    invoiceValueDifference: 0,
    reason: 'Invoice "ACO/26-27/227" matched without GSTIN (unregistered party)',
    reviewStatus: null,
    reviewedBy: null,
    reviewedAt: null,
    reviewNote: null,
    tally: { id: 1, voucherNumber: "ACO/26-27/227", voucherDate: "2026-08-18", partyName: "A", partyGSTIN: null, invoiceNumber: "ACO/26-27/227", taxableValue: 5904.7, totalAmount: 6200 },
    gst: { id: 1, invoiceNumber: "ACO/26-27/227", invoiceDate: "2026-08-18", counterpartyGstin: null, counterpartyName: "B", taxableValue: 5904.7, invoiceValue: 6200 },
    ...over,
  };
}

function renderPage() {
  return render(<Reconciliation />);
}

describe("Reconciliation", () => {
  beforeEach(() => {
    mockedUseAuth.mockReturnValue({
      user: { id: 1, name: "Admin", role: "ADMIN" },
      loading: false,
      login: vi.fn(),
      logout: vi.fn(),
    } as any);
    mockedApi.reconSummary.mockReset();
    mockedApi.reconResults.mockReset();
    mockedApi.reconRun.mockReset();
    mockedApi.reconReview.mockReset();
    mockedApi.reconExport.mockReset();
  });

  test("renders the reconciliation page with run controls", () => {
    mockedApi.reconSummary.mockResolvedValue({ success: false } as any);
    mockedApi.reconResults.mockResolvedValue({ ok: true, rows: [], total: 0, page: 1, pageSize: 50 } as any);
    renderPage();
    expect(screen.getByText("GST Reconciliation")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Run Reconciliation" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Export XLSX" })).toBeTruthy();
  });

  test("run calls the engine and shows summary stats + results", async () => {
    mockedApi.reconSummary.mockResolvedValue(summary());
    mockedApi.reconResults.mockResolvedValue({
      ok: true, rows: [row(), row({ id: 2, status: "MATCHED", confidence: 100 })], total: 2, page: 1, pageSize: 50,
    } as any);
    mockedApi.reconRun.mockResolvedValue(summary());
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Run Reconciliation" }));
    expect((await screen.findAllByText("2")).length).toBeGreaterThan(0); // Matched stat
    expect((await screen.findAllByText("POSSIBLE MATCH")).length).toBeGreaterThan(0);
    expect((await screen.findAllByText("MATCHED")).length).toBeGreaterThan(0);
    expect(mockedApi.reconRun).toHaveBeenCalledWith("2026-08", "SALES");
  });

  test("review flow saves ACCEPTED via the review API", async () => {
    mockedApi.reconSummary.mockResolvedValue(summary());
    mockedApi.reconResults
      .mockResolvedValueOnce({ ok: true, rows: [row()], total: 1, page: 1, pageSize: 50 } as any)
      .mockResolvedValue({
        ok: true,
        rows: [row({ reviewStatus: "ACCEPTED", reviewedBy: "Admin <admin@test.local>" })],
        total: 1, page: 1, pageSize: 50,
      } as any);
    mockedApi.reconReview.mockResolvedValue({
      ok: true, result: row({ reviewStatus: "ACCEPTED", reviewedBy: "Admin <admin@test.local>" }),
    } as any);
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Review" }));
    fireEvent.change(screen.getByLabelText("Review Note"), { target: { value: "Verified against ledger" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("ACCEPTED")).toBeTruthy();
    expect(mockedApi.reconReview).toHaveBeenCalledWith(1, "ACCEPTED", "Verified against ledger");
  });

  test("export buttons call the export API", async () => {
    mockedApi.reconSummary.mockResolvedValue(summary());
    mockedApi.reconResults.mockResolvedValue({ ok: true, rows: [row()], total: 1, page: 1, pageSize: 50 } as any);
    mockedApi.reconExport.mockResolvedValue(undefined);
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Export CSV" }));
    expect(mockedApi.reconExport).toHaveBeenCalledWith("2026-08", "SALES", "csv");
  });

  test("VIEWER cannot run or review", async () => {
    mockedUseAuth.mockReturnValue({
      user: { id: 2, name: "Viewer", role: "VIEWER" },
      loading: false,
      login: vi.fn(),
      logout: vi.fn(),
    } as any);
    mockedApi.reconSummary.mockResolvedValue({ success: false } as any);
    mockedApi.reconResults.mockResolvedValue({ ok: true, rows: [], total: 0, page: 1, pageSize: 50 } as any);
    renderPage();
    expect(screen.getByText("You do not have permission to run reconciliation.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Run Reconciliation" }) as HTMLButtonElement).disabled).toBe(true);
  });
});