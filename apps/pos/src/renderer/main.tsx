import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import "./app.css";
const root = document.getElementById("pos-root");
if (!root) throw new Error("POS root element missing");
createRoot(root).render(
  <StrictMode>
    <App bridge={window.dulja?.pos} />
  </StrictMode>,
);
