import React from "react";
import ReactDOM from "react-dom/client";

import { App } from "../sidepanel/App";
import "../sidepanel/styles.css";
import "./styles.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("OneDrop mobile page root was not found.");
}

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
