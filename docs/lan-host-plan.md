# Orvane Host

Start a task on the desktop, then carry on from a smaller laptop on the same network. The desktop keeps its projects, provider credentials, sessions, browser profiles, and running agents. On the laptop, open one app at a time. Use Ctrl+Left and Ctrl+Right or the app strip to switch. Each device keeps its own view and focus.

## First useful release

1. On the desktop, open Settings → Host access. Hosting starts off. Pick the private network interface, set an access password, and enable the listener. Show the address, connected devices, and a disconnect control. Offer to keep the host awake while serving. The display can turn off.
2. On the laptop, open the address and enter the password. Agent Sessions opens immediately. Reuse the session list, Claude Code and Codex provider/model choices, transcript, composer, run activity, questions, and permissions. List and resume the same sessions, start new ones in a host project, send a follow-up, stop a turn, or answer a request.
3. Refresh, close the laptop lid, or lose Wi-Fi during a run. The run continues on the desktop. Reconnect to the same transcript, pending requests, and run state. If the host is unavailable, keep the unsent text visible and disable actions until the connection is restored.
4. Once the two-device Agent Sessions workflow passes, add apps behind explicit adapters. Start with UI Maker review and comparison, then add editing. Browser and Terminal follow with host-side webview and PTY adapters. Each adapter declares the actions it supports and which require confirmation.

The two Lab variants cover the laptop and the desktop settings. Host settings appear in the laptop mock as a preview shortcut. In the product, settings that start or stop the listener stay on the desktop.

## Use Host access

1. On the desktop, open **Agent Sessions → Settings → Host access**. Select the private network interface, set an access password, and enter the project folders you want to share. Turn on **Host on local network**. Host access starts off after each desktop server restart. The setup values stay saved.
2. Download the public certificate from Settings and transfer it to the laptop. Install it in the laptop's trusted root certificate store only if it came from your own Orvane desktop. Open the HTTPS address shown in Settings. If Windows Firewall blocks the connection, allow the host port on the private subnet. Git for Windows includes the OpenSSL executable Orvane uses to issue its local certificate.
3. Sign in on the laptop. Open an existing chat or start a Claude Code or Codex chat in a shared project. Send follow-ups, review progress, or stop a turn. An interrupted send can be retried with the same request ID.
4. Enable **Approval from the laptop** to answer pending tool requests and provider questions in shared Agent Sessions. Enable **Share UI Maker** to browse versions, try Lab previews, or pick a variant on the desktop.
5. Enable **Share Browser** to open a desktop Browser tab from the laptop. To control an existing tab, use **Let AI use this tab** in its desktop tab menu. The laptop shows the live page as refreshed captures and sends input to the desktop tab.
6. Enable **Share open terminals** to grant full shell input to desktop terminals that are already open in a shared project. Switch among Agent Sessions, Browser, UI Maker, Terminal, and Recent runs with **Ctrl+Left/Right** or the app strip. Keyboard navigation stays with a focused input.
7. **Keep awake while hosting** prevents automatic system sleep while letting the display turn off. Turn hosting off to disconnect the laptop and release the sleep blocker. In-progress desktop agent runs continue. The local agent API stays on loopback.

## Optional development startup

For an environment-managed listener, use a TLS certificate the laptop trusts with a subject alternative name for the chosen address or local hostname. From the repository, generate a verifier file with masked input:

```powershell
Read-Host 'Host access password' -MaskInput | pnpm exec tsx scripts/orvane-host-password.ts C:\private\orvane-host.verifier
```

Set these variables in the process that starts Orvane, then open the HTTPS address on the laptop. Use a dedicated local hostname if the machine runs other HTTPS apps. The Windows firewall rule needs to allow the selected private subnet.

| Variable | Value |
| --- | --- |
| `ORVANE_HOST_ENABLED` | `1` opts in. Omit it to keep the listener off. |
| `ORVANE_HOST_BIND` | Private IPv4 address assigned to the host. |
| `ORVANE_HOST_NAME` | Optional hostname in the TLS certificate. Defaults to the bind address. |
| `ORVANE_HOST_PORT` | HTTPS port. Defaults to `8443`. |
| `ORVANE_HOST_CERT`, `ORVANE_HOST_KEY` | Paths to the TLS certificate and private key. |
| `ORVANE_HOST_VERIFIER` | Path to the verifier file generated above. |
| `ORVANE_HOST_PROJECTS` | Optional JSON list of absolute project folders, for example `["C:/Projects/Orvane"]`. Omit it for the runs watch page alone. |
| `ORVANE_HOST_APPROVALS` | `1` enables laptop approvals for shared Agent Sessions. |
| `ORVANE_HOST_UI_MAKER` | `1` exposes UI Maker versions and Lab picks to the authenticated laptop. |
| `ORVANE_HOST_TERMINAL` | `1` enables access to open terminals in shared projects. |
| `ORVANE_HOST_KEEP_AWAKE` | `1` prevents automatic system sleep while hosting from Electron. |

With shared projects set, sessions, terminals, and the run watch page are limited to those folders and their descendants. Sends from the laptop use the same edit mode the desktop would: the mode of that chat's latest desktop turn, otherwise the default set in Agent Sessions → Settings → Sessions. With laptop approvals disabled, pending approvals can be answered in desktop Agent Sessions.

The desktop switch can stop an environment-managed listener. Clear `ORVANE_HOST_ENABLED` before the next server start to keep it off. The display's sleep policy remains under the desktop's normal settings.

## Backend boundary

- Keep the desktop server and private MCP bridge on loopback. The current agent API enforces local, same-origin access in `server/agent-sessions-api.ts`. The dedicated LAN listener uses an explicit route table and reuses the runner behind it. The focused shell and its API share an HTTPS origin. Test certificate installation on two physical machines. Bind only to the selected interface and scope the Windows firewall rule to the private subnet. [OWASP session management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)
- Store a salted password verifier on the desktop. Rate-limit sign-in. Issue revocable, expiring sessions via Secure, HttpOnly, SameSite cookies. Check the session and capability on every route, stream, and asset. Validate Host and Origin and require a session-bound token on mutations. Turning hosting off or changing the password revokes access and ends streams. First release uses no public relay or port forwarding. [OWASP authentication](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html) · [OWASP CSRF prevention](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)
- Reuse the host's agent request and event flow behind typed session operations. Give each send a client request ID, deduplicate on the host, and serialize conflicting operations for the same conversation. Stream a snapshot followed by ordered updates. Reconnect from a cursor when possible, or refetch a snapshot. Reject a second reply to an already answered approval. Keep provider secrets, raw transcript paths, arbitrary filesystem routes, the MCP bridge, and Electron privileges out of the LAN route table.
- Keep established provider approval modes. Start remote sessions with the host's allowed project roots. A remote browser can answer an eligible approval with the action and target visible. Remote approvals and raw terminal input have separate opt-in settings. Render transcript text as untrusted content. UI Maker HTML runs in an opaque-origin sandbox with no access to remote session cookies or network requests.
- Keep one host workspace writer. Remote app changes use the same host commands and revisions as the desktop. A second browser never takes the desktop's editing lease. Persist app changes through the host, while leaving each browser's active app, scroll, and draft state local to that view.

## Delegation between providers

The **Continue with another model** command creates an editable draft with source context. The user sends it.

The full Orvane MCP connector now exposes `agent_delegate`. Keep the Orvane editing window open. Send a `request` object with `action: "start"`, a fresh UUID `requestId`, `provider` (`claude` or `codex`), an absolute project `folder`, and `message`. Optional fields select `model`, `effort`, an allowed edit `mode`, or a `sourceSessionKey` for the coordinator. The tool returns a run ID immediately and the provider's session ID once available. Repeat the exact request after a transport timeout to observe the same turn.

Use `status` with `runId` for progress, approval state, and result. Use `follow_up` with a finished run ID, new request ID, and message to resume the delegate's session. Use `stop` with a run ID to stop it. Approvals stay in desktop Agent Sessions. Delegated Orvane MCP subprocesses keep UI Maker tools and omit `agent_delegate`.

When the owner explicitly asks to restart Orvane, the full desktop MCP connector can call `desktop_restart` with `action: "schedule"` after checks are complete. The call returns while the restart is queued. Use `status` to see whether it is waiting for the local server, an active Agent Sessions turn, or a workspace save. Use `cancel` while the restart is pending. Restart closes desktop terminals, disconnects Host clients, and reopens with Host access off.

The product check is a Codex coordinator assigning Claude a UI Maker brief, Claude publishing a Lab variant through MCP, and Codex reviewing it while working on the backend. Laptop approval handling follows with remote chat.

## Acceptance on two machines

- An unauthenticated laptop can load the sign-in page only. Direct transcript, stream, asset, and action requests fail. A second network and a disabled host cannot reach the service.
- Start a Claude Code task on the desktop, resume it from the laptop, send a Codex follow-up in a separate session, and answer a real approval from the laptop. Verify the desktop shows the same changes and the laptop contains no provider credentials.
- Drop Wi-Fi between sending and receiving acknowledgement. Reconnect and confirm one user turn, one run, and the correct pending approval or completion. Try a rejected action, a stale approval, and host shutdown while the laptop is open.
- On the actual small laptop, keep chat readable at browser zoom and navigate with Ctrl+Left/Right without interrupting cursor movement in the composer. Check both host sleep settings and the laptop closing its lid during a turn.
