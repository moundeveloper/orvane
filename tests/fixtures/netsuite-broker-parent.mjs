import { startNetSuiteBroker } from "../../electron/netsuite-broker.mjs";
const broker = await startNetSuiteBroker({
  directory: process.argv[2],
  execPath: process.execPath,
  hosts: () => [],
  service: {},
});
process.send({ type: "ready", brokerPid: broker.pid });
process.on("disconnect", async () => {
  await broker.close();
  process.exit(0);
});
process.on("message", async (message) => {
  if (message === "stop") {
    await broker.close();
    process.exit(0);
  }
});
