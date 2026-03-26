const ERROR_MAP: Record<string, string> = {
    "not found": "This book file could not be found. It may have been moved or deleted.",
    "permission denied": "Permission denied. Check that the file is accessible.",
    "invalid format": "This file format is not supported.",
    "duplicate": "This book is already in your library.",
    "chapter index": "Could not load this chapter. Try restarting the reader.",
    "corrupt": "This file appears to be damaged and cannot be opened.",
};

export function friendlyError(raw: string): string {
    const lower = raw.toLowerCase();
    for (const [key, message] of Object.entries(ERROR_MAP)) {
        if (lower.includes(key)) return message;
    }
    return "Something went wrong. Please try again.";
}
