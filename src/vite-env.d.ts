/// <reference types="vite/client" />

declare module "@fontsource-variable/lora";
declare module "@fontsource-variable/lora/wght-italic.css";
declare module "@fontsource-variable/literata";
declare module "@fontsource-variable/literata/wght-italic.css";

declare module "virtual:release-notes" {
  import type { ReleaseVersion } from "../vite-plugin-release-notes";
  export const releaseNotes: ReleaseVersion[];
  export const appVersion: string;
}
