// First, so its listeners exist before any other module runs (see the file).
import "./dev-hooks";
import { render } from "preact";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/shell.css";
import "./styles/composer.css";
import "./styles/transcript.css";
import App from "./App";
import { applyTheme, resolveTheme, systemPrefersDark } from "./lib/theme";

// The OS preference before the first paint; the saved setting, if any, is applied by the
// App once the agent has answered `config.get`. Dark until then on a light system is a
// flash of one frame, and the stylesheet's default is dark for the same reason.
applyTheme(resolveTheme("system", systemPrefersDark()));

// preact/debug names the component and the rule broken — "hook called outside render",
// a missing key — where production preact says "cannot read 'context' of undefined".
// Development only: it is a runtime cost and a bundle cost, and neither belongs in a
// release.
if (import.meta.env.DEV) await import("preact/debug");

render(<App />, document.getElementById("root")!);
