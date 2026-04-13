import { describe, it, expect } from "vitest";
import type { TFunction } from "i18next";
import { friendlyError } from "./errors";

const mockT = ((key: string) => key) as TFunction;

describe("friendlyError", () => {
    it("maps 'cannot open file' errors", () => {
        expect(friendlyError("Cannot open file: No such file or directory (os error 2)", mockT)).toBe("errors.fileNotFound");
    });

    it("maps 'no such file or directory' errors", () => {
        expect(friendlyError("No such file or directory", mockT)).toBe("errors.fileNotFound");
    });

    it("maps 'book file not found' errors", () => {
        expect(friendlyError("Book file not found at '/path/to/book.epub'", mockT)).toBe("errors.fileNotFound");
    });

    it("maps pdfium errors to PDF-specific message", () => {
        expect(friendlyError("pdfium library not found: some details", mockT)).toBe("errors.pdfium");
    });

    it("does not map pdfium errors to file-not-found", () => {
        expect(friendlyError("pdfium library not found", mockT)).not.toBe("errors.fileNotFound");
    });

    it("maps duplicate errors", () => {
        expect(friendlyError("Book is a duplicate", mockT)).toBe("errors.duplicate");
    });

    it("returns raw error for unknown errors", () => {
        expect(friendlyError("something unknown", mockT)).toBe("something unknown");
    });

    it("maps timeout errors", () => {
        expect(friendlyError("request timed out", mockT)).toBe("errors.timeout");
    });

    it("maps connection refused errors", () => {
        expect(friendlyError("connection refused", mockT)).toBe("errors.networkError");
    });

    it("maps HTTP error messages", () => {
        expect(friendlyError("HTTP error: connection reset", mockT)).toBe("errors.networkError");
    });

    it("maps URL blocked errors", () => {
        expect(friendlyError("URL blocked: only public HTTP/HTTPS URLs are allowed.", mockT)).toBe("errors.urlBlocked");
    });

    it("maps too large errors", () => {
        expect(friendlyError("Response too large (limit: 5 MB).", mockT)).toBe("errors.tooLarge");
    });
});
