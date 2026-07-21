import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { installCrashReporter } from "./crashReporter";
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "./styles/themes.css";

installCrashReporter();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
