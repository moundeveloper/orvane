import { createHash, randomUUID } from "node:crypto";
import { brokerError } from "./netsuite-broker-protocol.mjs";

/** Explicit in-flight sharing only. Completed values and failures are never cached. */
export function createSharedNetSuiteReads({
  maxGroups = 32,
  maxParticipants = 32,
} = {}) {
  const flights = new Map();
  const share = async (identity, execute) => {
    const key = createHash("sha256")
      .update(JSON.stringify(identity))
      .digest("hex");
    let flight = flights.get(key);
    const joined = !!flight;
    if (flight && flight.participants >= maxParticipants)
      throw brokerError(
        "READ_SHARING_BUSY",
        "This shared read has reached its participant limit.",
      );
    if (!flight) {
      if (flights.size >= maxGroups)
        throw brokerError(
          "READ_SHARING_BUSY",
          "The in-flight read budget is full. Try after current reads finish.",
        );
      flight = { executionId: randomUUID(), participants: 0, promise: null };
      flights.set(key, flight);
      flight.promise = Promise.resolve()
        .then(execute)
        .finally(() => flights.delete(key));
    }
    flight.participants++;
    try {
      const result = await flight.promise;
      return {
        ...structuredClone(result),
        readSharing: {
          mode: "in-flight",
          executionId: flight.executionId,
          joined,
          participants: flight.participants,
          cacheHit: false,
        },
      };
    } catch (error) {
      // Each caller's journal attaches its own requestId. Never share mutable Errors.
      throw Object.assign(
        new Error(
          error instanceof Error ? error.message : "Shared read failed.",
        ),
        {
          name: error?.name || "Error",
          code: error?.code || "NETSUITE_ERROR",
        },
      );
    }
  };
  share.budget = () => ({
    activeGroups: flights.size,
    activeParticipants: [...flights.values()].reduce(
      (sum, flight) => sum + flight.participants,
      0,
    ),
    maxGroups,
    maxParticipants,
  });
  return share;
}
