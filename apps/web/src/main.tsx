import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import { App } from "./app/App";
import { queryClient } from "./app/queryClient";
import "./styles/tokens.css";
import "./styles/global.css";
import "./styles/shell.css";
import "./styles/forms.css";
import "./styles/chat.css";
import "./styles/editor.css";
import "./styles/responsive.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root mount point");

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
