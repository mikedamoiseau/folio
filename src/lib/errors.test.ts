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

    it("returns generic message for unknown errors", () => {
        expect(friendlyError("something unknown", mockT)).toBe("errors.generic");
    });
});
