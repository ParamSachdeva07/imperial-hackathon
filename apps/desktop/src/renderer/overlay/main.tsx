import { createRoot } from "react-dom/client";
import { OverlayRoot } from "./OverlayRoot";
import "./overlay.css";

const root = document.getElementById("root");
if (root) createRoot(root).render(<OverlayRoot />);
