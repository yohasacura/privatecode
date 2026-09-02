import { render } from "preact";
import "./styles/tokens.css";
import App from "./App";
import { applyTheme, resolveTheme, systemPrefersDark } from "./lib/theme";

// The OS preference before the first paint; the saved setting, if any, is applied by the
// App once the agent has answered `config.get`. Dark until then on a light system is a
// flash of one frame, and the stylesheet's default is dark for the same reason.
applyTheme(resolveTheme("system", systemPrefersDark()));

render(<App />, document.getElementById("root")!);
