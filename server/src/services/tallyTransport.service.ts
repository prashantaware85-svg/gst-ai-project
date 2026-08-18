import { tallyMode, tallyUrl } from "../utils/config";
import {
  bridgeConnected,
  bridgeRequest,
  bridgeRequestTimeoutFor,
} from "./tallyBridgeServer.service";
import {
  fetchCurrentCompany as directFetchCurrentCompany,
  fetchVouchers as directFetchVouchers,
} from "./tally.service";

// TallyTransport – the one place the backend decides HOW it reaches TallyPrime.
//
//  direct: POST XML envelopes to TALLY_URL (http://localhost:9000). Delegate to
//          tally.service unchanged, so local dev and the existing test suite
//          behave exactly as before.
//  bridge: relay the operation to the Windows Tally Bridge agent over its
//          outbound WebSocket (see tallyBridgeServer.service). No XML ever
//          crosses the Render network; the agent executes the very same
//          tally.service code on the user's PC and returns normalized JSON.
//
// The public functions keep tally.service's signatures and throw the same
// contract (TallyError for usable-but-invalid responses; plain Error for
// transport failures) so callers / routes do not change their error mapping.
import type { NormalizedVoucher, VoucherKind } from "./tally.service";

export type { NormalizedVoucher, VoucherKind } from "./tally.service";

export function transportMode(): "direct" | "bridge" {
  return tallyMode();
}

export function transportBridgeConnected(): boolean {
  return bridgeConnected();
}

// Any HTTP response (even an error envelope) means TallyPrime is reachable;
// only transport-level failures count as "not connected". Throws on failure.
export async function pingTally(): Promise<void> {
  if (tallyMode() === "bridge") {
    await bridgeRequest("ping", {}, bridgeRequestTimeoutFor("ping"));
    return;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3_000);
  try {
    await fetch(tallyUrl(), {
      method: "POST",
      headers: { "Content-Type": "text/xml" },
      body: "<ENVELOPE></ENVELOPE>",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchCurrentCompany(): Promise<{ companyName: string; gstin: string | null }> {
  if (tallyMode() === "bridge") {
    const data = await bridgeRequest("company", {}, bridgeRequestTimeoutFor("company"));
    return data as { companyName: string; gstin: string | null };
  }
  return directFetchCurrentCompany();
}

export async function fetchVouchers(
  kind: VoucherKind,
  fromDate: string,
  toDate: string,
): Promise<{ raw: any[]; vouchers: NormalizedVoucher[] }> {
  if (tallyMode() === "bridge") {
    const data = await bridgeRequest(
      "vouchers",
      { kind, fromDate, toDate },
      bridgeRequestTimeoutFor("vouchers"),
    );
    return data as { raw: any[]; vouchers: NormalizedVoucher[] };
  }
  return directFetchVouchers(kind, fromDate, toDate);
}