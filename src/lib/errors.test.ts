import { describe, it, expect } from "vitest";
import { friendlyError } from "./errors";

describe("friendlyError", () => {
    it("maps 'not found' errors", () => {
        expect(friendlyError("Failed to import: file not found")).toContain("could not be found");
    });

    it("maps duplicate errors", () => {
        expect(friendlyError("Book is a duplicate")).toContain("already in your library");
    });

    it("returns generic message for unknown errors", () => {
        expect(friendlyError("something unknown")).toBe("Something went wrong. Please try again.");
    });
});
