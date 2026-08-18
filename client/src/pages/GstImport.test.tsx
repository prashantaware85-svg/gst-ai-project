import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import GstImport from "./GstImport";
import { api } from "../api/client";
import { useAuth } from "../hooks/useAuth";

vi.mock("../api/client", () => ({
  api: {
    gstValidate: vi.fn(),
    gstImport: vi.fn(),
    gstImports: vi.fn(),
    gstImportDetail: vi.fn(),
  },
}));

vi.mock("../hooks/useAuth", () => ({ useAuth: vi.fn() }));

const mockedApi = vi.mocked(api);
const mockedUseAuth = vi.mocked(useAuth);

function summary(over: Record<string, unknown> = {}) {
  return {
    success: true,
    batchId: 1,
    fileName: "gstr1.csv",
    returnType: "GSTR1",
    period: "2026-08",
    totalRows: 3,
    valid: 3,
    invalid: 0,
    duplicates: 0,
    imported: 3,
    errors: [],
    ...over,
  };
}

function renderPage() {
  return render(<GstImport />);
}

function file(): File {
  return new File(["a,b"], "gstr1.csv", { type: "text/csv" });
}

describe("GstImport", () => {
  beforeEach(() => {
    mockedUseAuth.mockReturnValue({
      user: { id: 1, name: "Admin", role: "ADMIN" },
      loading: false,
      login: vi.fn(),
      logout: vi.fn(),
    } as any);
    mockedApi.gstImports.mockResolvedValue({ ok: true, count: 0, batches: [] } as any);
    mockedApi.gstValidate.mockReset();
    mockedApi.gstImport.mockReset();
    mockedApi.gstImportDetail.mockReset();
  });

  test("renders the import page with return type, period and file controls", () => {
    renderPage();
    expect(screen.getByText("GST Import")).toBeTruthy();
    expect(screen.getByText("GSTR-1 (Sales)")).toBeTruthy();
    expect(screen.getByText("Validate File")).toBeTruthy();
    expect(screen.getByText("Import")).toBeTruthy();
  });

  test("import uploads the chosen file to /gst/import and shows the summary", async () => {
    mockedApi.gstImport.mockResolvedValue(summary());
    renderPage();
    fireEvent.change(screen.getByLabelText("GST file"), { target: { files: [file()] } });
    fireEvent.click(screen.getByText("Import"));
    expect(await screen.findByText("3 row(s) imported into the GST transaction store.")).toBeTruthy();
    expect(mockedApi.gstImport).toHaveBeenCalledWith("GSTR1", "2026-08", expect.any(File));
    // History refresh after import.
    await waitFor(() => expect(mockedApi.gstImports).toHaveBeenCalled());
  });

  test("validate reports counts without importing", async () => {
    mockedApi.gstValidate.mockResolvedValue(summary({ imported: 0, batchId: undefined }));
    renderPage();
    fireEvent.change(screen.getByLabelText("GST file"), { target: { files: [file()] } });
    fireEvent.click(screen.getByText("Validate File"));
    expect(await screen.findByText("Nothing new imported — all rows were duplicates or invalid.")).toBeTruthy();
    expect(mockedApi.gstValidate).toHaveBeenCalledWith("GSTR1", "2026-08", expect.any(File));
    expect(mockedApi.gstImport).not.toHaveBeenCalled();
  });

  test("import without a file shows a message and does not call the API", () => {
    renderPage();
    fireEvent.click(screen.getByText("Import"));
    expect(screen.getByText("Please choose a GST export file first.")).toBeTruthy();
    expect(mockedApi.gstImport).not.toHaveBeenCalled();
  });

  test("duplicate-only import surfaces the duplicates summary", async () => {
    mockedApi.gstImport.mockResolvedValue(
      summary({ imported: 0, duplicates: 3, errors: ["3 record(s) already present in the database"] }),
    );
    renderPage();
    fireEvent.change(screen.getByLabelText("GST file"), { target: { files: [file()] } });
    fireEvent.click(screen.getByText("Import"));
    expect(await screen.findByText("Nothing new imported — all rows were duplicates or invalid.")).toBeTruthy();
    expect(await screen.findByText("3 record(s) already present in the database")).toBeTruthy();
  });

  test("parse failures surface a friendly message", async () => {
    mockedApi.gstImport.mockRejectedValue({
      response: { status: 400, data: { message: "File is not a valid Excel/CSV spreadsheet" } },
    });
    renderPage();
    fireEvent.change(screen.getByLabelText("GST file"), { target: { files: [file()] } });
    fireEvent.click(screen.getByText("Import"));
    expect(await screen.findByText("File is not a valid Excel/CSV spreadsheet")).toBeTruthy();
  });

  test("import history batches render with counts", async () => {
    mockedApi.gstImports.mockResolvedValue({
      ok: true,
      count: 1,
      batches: [
        {
          id: 7, returnType: "GSTR1", fileName: "gstr1.csv", period: "2026-08",
          totalRows: 3, validRows: 3, invalidRows: 0, duplicateRows: 0, importedRows: 3,
          createdAt: "2026-08-18T09:00:00.000Z",
        },
      ],
    } as any);
    renderPage();
    expect(await screen.findByText("GSTR1 · 2026-08")).toBeTruthy();
    expect(screen.getByText("gstr1.csv")).toBeTruthy();
  });

  test("VIEWER cannot import", async () => {
    mockedUseAuth.mockReturnValue({
      user: { id: 2, name: "Viewer", role: "VIEWER" },
      loading: false,
      login: vi.fn(),
      logout: vi.fn(),
    } as any);
    renderPage();
    expect(screen.getByText("You do not have permission to import GST data.")).toBeTruthy();
  });
});