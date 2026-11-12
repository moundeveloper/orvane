const originOf = (url) => {
  try {
    const value = new URL(url);
    return value.protocol === "https:" &&
      /^[a-z0-9-]+\.app\.netsuite\.com$/i.test(value.hostname)
      ? value.origin
      : null;
  } catch {
    return null;
  }
};

/** Observed source-page lifecycle, not server-side verification of a cookie session. */
export function createNetSuiteSessionTracker() {
  const epochs = new Map();
  const key = (host, origin) =>
    `${typeof host === "number" ? host : host.id}:${origin}`;
  const current = (host, origin) => {
    const id = key(host, origin);
    if (!epochs.has(id)) epochs.set(id, 1);
    return epochs.get(id);
  };
  const invalidate = (host, origin) => {
    if (host && origin)
      epochs.set(key(host, origin), current(host, origin) + 1);
  };
  return {
    current,
    invalidate,
    observe(contents) {
      let previous = originOf(contents.getURL()),
        owner = contents.hostWebContents?.id;
      contents.on(
        "did-start-navigation",
        (details, legacyUrl, legacyInPlace, legacyMain) => {
          const main = details?.isMainFrame ?? legacyMain;
          const inPlace = details?.isSameDocument ?? legacyInPlace;
          if (!main || inPlace) return;
          owner = contents.hostWebContents?.id || owner;
          const next = originOf(details?.url ?? legacyUrl);
          invalidate(owner, previous);
          if (next && next !== previous) invalidate(owner, next);
          previous = next;
        },
      );
      contents.on("did-navigate", (_event, url) => {
        previous = originOf(url);
        owner = contents.hostWebContents?.id || owner;
      });
      const gone = () => invalidate(owner, previous);
      contents.on("render-process-gone", gone);
      contents.on("destroyed", gone);
    },
  };
}
