import { describe, test, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import Login from "./Login";
import { useAuth } from "../hooks/useAuth";

vi.mock("../hooks/useAuth", () => ({ useAuth: vi.fn() }));

const mockedUseAuth = vi.mocked(useAuth);

function renderLogin() {
  return render(
    <MemoryRouter initialEntries={["/login"]}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/" element={<div>dashboard-marker</div>} />
      </Routes>
    </MemoryRouter>
  );
}

describe("Login", () => {
  test("guest authenticated user visiting /login redirects to /", () => {
    mockedUseAuth.mockReturnValue({
      user: { id: 0, name: "Guest", role: "VIEWER" },
      loading: false,
      login: vi.fn(),
      logout: vi.fn(),
    });
    renderLogin();
    expect(screen.getByText("dashboard-marker")).toBeTruthy();
  });

  test("while auth is loading shows a Loading state", () => {
    mockedUseAuth.mockReturnValue({
      user: null,
      loading: true,
      login: vi.fn(),
      logout: vi.fn(),
    });
    renderLogin();
    expect(screen.getByText("Loading...")).toBeTruthy();
  });

  test("with no user shows the normal login form", () => {
    mockedUseAuth.mockReturnValue({
      user: null,
      loading: false,
      login: vi.fn(),
      logout: vi.fn(),
    });
    renderLogin();
    expect(screen.getByPlaceholderText("Email")).toBeTruthy();
    expect(screen.getByPlaceholderText("Password")).toBeTruthy();
  });
});