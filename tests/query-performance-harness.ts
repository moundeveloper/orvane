import { createApp, h, reactive, ref } from "vue";
import Query from "../src/components/NetSuiteQuery.vue";
import type { Block } from "../src/model";

export function mountQueryFixture() {
  const files = reactive([
    { id: "alpha", name: "Alpha", sql: "SELECT id, name FROM customer" },
    { id: "beta", name: "Beta", sql: "SELECT id FROM vendor" },
    { id: "gamma", name: "Gamma", sql: "SELECT id FROM employee" },
  ]);
  const block = reactive({
    id: "queries",
    kind: "netsuite",
    value: JSON.stringify({
      queryTabs: {
        fixture: { open: ["alpha", "beta", "gamma"], active: "alpha" },
      },
    }),
  }) as unknown as Block;
  const environment = ref("fixture-env");
  const calls: { operation: string; sql?: string; offset?: number }[] = [];
  let deferNext = false;
  let pending: (() => void) | undefined;
  const request = async (
    operation: string,
    args: Record<string, unknown> = {},
  ) => {
    calls.push({ operation, ...args });
    if (operation === "query") {
      if (deferNext) {
        deferNext = false;
        await new Promise<void>((resolve) => (pending = resolve));
      }
      return {
        rows: [{ id: 1, name: `Result: ${args.sql}` }],
        totalCount: 1,
        offset: args.offset ?? 0,
      };
    }
    return { data: [], rows: [] };
  };
  const root = document.createElement("div");
  root.id = "query-fixture";
  root.style.cssText =
    "position:fixed;inset:0;background:white;z-index:999999;";
  document.body.appendChild(root);
  const app = createApp({
    render: () =>
      h(Query, {
        block,
        environment: environment.value,
        request,
        openRecord: () => {},
        files,
        stateKey: "fixture",
      }),
  });
  app.mount(root);
  return {
    calls,
    get queries() {
      return calls.filter((call) => call.operation === "query").length;
    },
    get files() {
      return files;
    },
    defer() {
      deferNext = true;
    },
    complete() {
      pending?.();
      pending = undefined;
    },
    changeEnvironment() {
      environment.value = "other-env";
    },
    remove(id: string) {
      const index = files.findIndex((file) => file.id === id);
      if (index >= 0) files.splice(index, 1);
    },
    recreate(id: string, sql = "SELECT id FROM item") {
      files.push({ id, name: "Recreated", sql });
    },
    unmount() {
      app.unmount();
      root.remove();
    },
  };
}
