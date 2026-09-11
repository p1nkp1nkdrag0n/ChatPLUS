import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import { App } from "./app/App";
import { queryClient } from "./app/queryClient";
import "./styles/tokens.css";
import "./styles/global.css";
import "./styles/shell.css";
import "./styles/forms.css";
import "./styles/chat.css";
import "./styles/editor.css";
import "./styles/correspondence.css";
import "./styles/archive.css";
import "./styles/responsive.css";
import "./styles/dearvale.css";
import "./styles/llm-settings.css";
import "./styles/achievements.css";
import "./styles/creation.css";
import "./styles/api-setup.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root mount point");
// A data router gives settings a supported blocker for links and browser history.
const router = createBrowserRouter([{ path: "*", element: <App /> }]);

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
