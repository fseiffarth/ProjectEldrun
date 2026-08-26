import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { ErrorBoundary } from "./ErrorBoundary";
import "./style.css";

if ("serviceWorker" in navigator) window.addEventListener("load", () => void navigator.serviceWorker.register("/sw.js"));
ReactDOM.createRoot(document.getElementById("root")!).render(<React.StrictMode><ErrorBoundary><App /></ErrorBoundary></React.StrictMode>);

