const modules = import.meta.glob("../pages/**/main.ts");
const pages = import.meta.glob("../pages/**/view.html", {
  query: "?raw",
  import: "default",
});

export async function loadRoute(route: string) {
  const app = document.getElementById("app")!;

  const htmlLoader = pages[`../pages/${route}/view.html`];
  if (!htmlLoader) return;

  app.innerHTML = (await htmlLoader()) as string;

  const moduleLoader = modules[`../pages/${route}/main.ts`];
  const mod: any = await moduleLoader?.();

  mod?.init?.();
}
