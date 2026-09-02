import { render } from "preact";
import "./styles/tokens.css";
import App from "./App";
import { applyTheme, resolveTheme, systemPrefersDark } from "./lib/theme";

// The OS preference before the first paint; the saved setting, if any, is applied by the
// App once the agent has answered `config.get`. Dark until then on a light system is a
// flash of one frame, and the stylesheet's default is dark for the same reason.
// Preact flushes re-renders in a microtask, so a component that throws while re-rendering
// surfaces as an unhandled rejection with its stack cut short by the console. In
// development, say where it came from.
if (import.meta.env.DEV) {
  window.addEventListener("unhandledrejection", (e) => {
    const reason = e.reason as { stack?: string } | undefined;
    console.error("[dev] unhandled rejection:", reason?.stack ?? String(e.reason));
  });
}

applyTheme(resolveTheme("system", systemPrefersDark()));

render(<App />, document.getElementById("root")!);
