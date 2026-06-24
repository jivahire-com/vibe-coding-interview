// Optional dev playground entry point — NOT graded and NOT part of the
// challenge. The grader only runs the test suite; nothing here is imported by
// the tests. It mounts <App /> so you can click through your useCart hook in a
// real browser via `npm run dev`.
import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.jsx";
import "./playground.css";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
