import React from "react";
import ReactDOM from "react-dom/client";

// UI fonts — loaded eagerly (DM Sans for body, Playfair Display for serif headings)
import "@fontsource-variable/dm-sans";
import "@fontsource-variable/dm-sans/wght-italic.css";
import "@fontsource-variable/playfair-display";

// Reading fonts (Lora, Literata) loaded on demand by src/lib/fontLoader.ts
// when the user selects them — saves ~120KB from initial bundle.
import { preloadStoredFont } from "./lib/fontLoader";

import "./i18n";

preloadStoredFont();
import "./index.css";
import App from "./App";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
