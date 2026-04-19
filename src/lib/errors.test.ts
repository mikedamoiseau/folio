import { describe, it, expect } from "vitest";
import type { TFunction } from "i18next";
import { friendlyError, toFolioError } from "./errors";

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

    describe("structured FolioError payloads", () => {
        it("unwraps {kind, message} before matching", () => {
            const err = { kind: "NotFound", message: "Book file not found at '/x.epub'" };
            expect(friendlyError(err, mockT)).toBe("errors.fileNotFound");
        });

        it("falls back to kind when message has no substring match", () => {
            const err = { kind: "NotFound", message: "Entry missing" };
            expect(friendlyError(err, mockT)).toBe("errors.fileNotFound");
        });

        it("maps PermissionDenied kind even with a custom message", () => {
            const err = { kind: "PermissionDenied", message: "Keychain access refused" };
            expect(friendlyError(err, mockT)).toBe("errors.permissionDenied");
        });

        it("maps Network kind to generic network key", () => {
            const err = { kind: "Network", message: "BnF HTTP 503" };
            expect(friendlyError(err, mockT)).toBe("errors.networkError");
        });

        it("falls back to InvalidInput kind when message has no specific match", () => {
            const err = { kind: "InvalidInput", message: "Title cannot be empty." };
            expect(friendlyError(err, mockT)).toBe("errors.invalidInput");
        });

        it("maps Database kind to generic database key", () => {
            const err = { kind: "Database", message: "database is locked" };
            expect(friendlyError(err, mockT)).toBe("errors.database");
        });

        it("maps Io kind to generic io key", () => {
            const err = { kind: "Io", message: "disk full" };
            expect(friendlyError(err, mockT)).toBe("errors.io");
        });

        it("maps Serialization kind to corrupt key", () => {
            const err = { kind: "Serialization", message: "unexpected end of file" };
            expect(friendlyError(err, mockT)).toBe("errors.corrupt");
        });

        it("maps Internal kind to generic key", () => {
            const err = { kind: "Internal", message: "oops" };
            expect(friendlyError(err, mockT)).toBe("errors.generic");
        });

        it("handles Error instances", () => {
            expect(friendlyError(new Error("HTTP error: connection reset"), mockT)).toBe("errors.networkError");
        });

        it("toFolioError extracts kind+message from payload", () => {
            expect(toFolioError({ kind: "Internal", message: "oops" })).toEqual({
                kind: "Internal",
                message: "oops",
            });
        });

        it("toFolioError wraps bare strings", () => {
            expect(toFolioError("hello")).toEqual({ message: "hello" });
        });

        it("toFolioError handles null and undefined gracefully", () => {
            expect(toFolioError(null).message).toBeTruthy();
            expect(toFolioError(undefined).message).toBeTruthy();
        });
    });
});
