import base from "./playwright.config";
const url = "http://127.0.0.1:5294";
export default { ...base, use: { ...base.use, baseURL: url }, webServer: { ...base.webServer, reuseExistingServer: process.env.ORVANE_REUSE_TEST_SERVER === "1",
  command: "pnpm exec vite --host 127.0.0.1 --port 5294 --strictPort --mode test-storage", url } };

