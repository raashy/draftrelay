import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "../client/styles.css";
import "./cloud.css";
import CloudApp from "./CloudApp";

document.body.classList.add("cloud-app-body");

const root = document.getElementById("root");
if (!root) throw new Error("Missing cloud application root");

createRoot(root).render(
  <StrictMode>
    <CloudApp />
  </StrictMode>
);
