import { IErrorEnvelope, ISuccessEnvelope } from "../interfaces";

// Response envelope helpers — TECH_SPEC_V1.md §4.3, matching the file-manager-api
// convention: { status, error, data } on success, { status, error, errorMsg } on
// failure.
export function success<T>(data: T): ISuccessEnvelope<T> {
  return { status: "ok", error: false, data };
}

export function failure(errorMsg: string): IErrorEnvelope {
  return { status: "error", error: true, errorMsg };
}
