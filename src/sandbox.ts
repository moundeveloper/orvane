import { uid } from "./model";
// User actions run in an opaque-origin frame and a terminable worker. No main-thread eval.
export function runIsolated(code: string, value: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts");
    frame.hidden = true;
    const token = uid();
    const cleanup = () => {
      clearTimeout(timer);
      window.removeEventListener("message", listener);
      frame.remove();
    };
    const listener = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow || event.data?.token !== token)
        return;
      if (event.data.ready) {
        clearTimeout(timer);
        timer = setTimeout(() => {
          cleanup();
          reject(new Error("Custom action exceeded its 2-second time limit."));
        }, 2200);
        return;
      }
      cleanup();
      if ("error" in event.data) reject(new Error(String(event.data.error)));
      else resolve(String(event.data.value ?? ""));
    };
    let timer = setTimeout(() => {
      cleanup();
      reject(new Error("Custom action exceeded its 2-second time limit."));
    }, 10000);
    window.addEventListener("message", listener);
    const payload = JSON.stringify({ token, code, value }).replace(
      /</g,
      "\\u003c",
    );
    frame.srcdoc = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:; worker-src blob:; connect-src 'none'; base-uri 'none'">
      <script>
      const payload = ${payload};
      const respond = result => parent.postMessage({...result, token: payload.token}, '*');
      try {
        const source = 'postMessage({ready:true});onmessage=async(e)=>{try{const result=await (new Function("value",e.data.code))(e.data.value);postMessage({value:String(result??"")})}catch(e){postMessage({error:String(e?.message ?? e)})}}';
        const worker = new Worker(URL.createObjectURL(new Blob([source], {type:'text/javascript'})));
        worker.onmessage = e => {if(e.data.ready){respond({ready:true});worker.postMessage(payload);setTimeout(()=>{worker.terminate();respond({error:'Custom action exceeded its 2-second time limit.'})},2000);return}worker.terminate(); respond(e.data)};
        worker.onerror = e => {worker.terminate(); respond({error:String(e?.message ?? e) || 'Custom action could not run.'})};
      } catch(e) {respond({error:String(e?.message ?? e)})}
      <\/script>`;
    document.body.append(frame);
  });
}
