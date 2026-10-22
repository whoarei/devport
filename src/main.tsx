import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./i18n";
import "./styles.css";
import "./theme.css";
import { initializeTheme } from "./theme";

initializeTheme();

// 捕获阶段禁用 WebView 默认菜单，覆盖会 stopPropagation 的输入框和按钮。
// 仅阻止默认行为，继续传递事件，让各面板的自定义右键菜单正常打开。
document.addEventListener("contextmenu", (event) => event.preventDefault(), true);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
