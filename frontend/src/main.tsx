import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { PhoneFrame } from "./components/PhoneFrame";
import { router } from "./routes";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <PhoneFrame>
      <ErrorBoundary>
        <RouterProvider router={router} />
      </ErrorBoundary>
    </PhoneFrame>
  </StrictMode>
);
