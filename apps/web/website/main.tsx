import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import LandingPage from "../src/pages/LandingPage";
import "../src/styles/tokens.css";
import "../src/styles/global.css";
import "../src/styles/website.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root mount point");
const appUrl =
  import.meta.env["VITE_APP_URL"]?.trim() || "http://127.0.0.1:5173/welcome";

createRoot(root).render(
  <StrictMode>
    <LandingPage appUrl={appUrl} />
  </StrictMode>,
);
