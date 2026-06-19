import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { installCrashReporter } from "./crashReporter";
import "./styles/themes.css";

installCrashReporter();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
