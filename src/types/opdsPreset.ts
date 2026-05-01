export type LanguageCode =
  | "en"
  | "fr"
  | "de"
  | "es"
  | "it"
  | "pt"
  | "ja"
  | "zh"
  | "ru"
  | "pl"
  | "nl"
  | "sv"
  | "fi"
  | "da"
  | "hu"
  | "bg"
  | "be"
  | "multi";

export type Category =
  | "public-domain"
  | "literature"
  | "tech"
  | "academic"
  | "fiction"
  | "religion"
  | "politics"
  | "commercial";

export interface Preset {
  id: string;
  name: string;
  url: string;
  languages: LanguageCode[];
  categories: Category[];
  description: string;
}

export const ALL_LANGUAGES: readonly LanguageCode[] = [
  "en", "fr", "de", "es", "it", "pt", "ja", "zh", "ru",
  "pl", "nl", "sv", "fi", "da", "hu", "bg", "be", "multi",
] as const;

export const ALL_CATEGORIES: readonly Category[] = [
  "public-domain", "literature", "tech", "academic",
  "fiction", "religion", "politics", "commercial",
] as const;
