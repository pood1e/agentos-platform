import { App, applyDocumentTheme, applyHostStyleVariables } from "@modelcontextprotocol/ext-apps";

const app = new App({ name: "Platform fixture", version: "1.0.0" }, {});
const output = document.querySelector("output");
function text(id: string, value: string) {
  const node = document.getElementById(id);
  if (node) node.textContent = value;
}
app.ontoolinput = (params) => text("input", JSON.stringify(params.arguments));
app.ontoolresult = (params) =>
  text("result", JSON.stringify(params.structuredContent ?? params.content));
app.onhostcontextchanged = (context) => {
  if (context.theme) {
    applyDocumentTheme(context.theme);
    text("theme", context.theme);
  }
  if (context.styles?.variables) applyHostStyleVariables(context.styles.variables);
};
document.getElementById("query")?.addEventListener("click", () => {
  void app
    .callServerTool({ name: "graph_data", arguments: { focus: "router-1" } })
    .then((result) => {
      if (output) output.textContent = JSON.stringify(result.structuredContent);
    });
});
document.getElementById("prefill")?.addEventListener("click", () => {
  void app.sendMessage({ role: "user", content: [{ type: "text", text: "继续检查 router-1" }] });
});
document.getElementById("unsafe")?.addEventListener("click", () => {
  void app.openLink({ url: "javascript:alert(1)" }).catch(() => text("denied", "blocked"));
});
for (const name of ["destroy", "other-service_graph_data"]) {
  document.getElementById(name)?.addEventListener("click", () => {
    void app.callServerTool({ name }).catch(() => text("denied", `blocked ${name}`));
  });
}
await app.connect();
const context = app.getHostContext();
if (context?.theme) {
  applyDocumentTheme(context.theme);
  text("theme", context.theme);
}
if (context?.styles?.variables) applyHostStyleVariables(context.styles.variables);
