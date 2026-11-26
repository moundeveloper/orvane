// The host checks this per-sign-in token on every request that changes state.
const csrf = document.querySelector<HTMLMetaElement>('meta[name="orvane-csrf"]')?.content ?? "";
const send = window.fetch.bind(window);
window.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input), location.href);
  if (url.origin !== location.origin) return send(input, init);
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  headers.set("x-orvane-csrf", csrf);
  return send(input, { ...init, headers });
};

export {};
