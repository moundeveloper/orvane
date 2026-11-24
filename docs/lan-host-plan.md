# Orvane Host

Start a task on the desktop, then carry on from a smaller laptop on the same network. The desktop keeps its projects, provider credentials, sessions, browser profiles, and running agents. On the laptop, open one app at a time. Use Ctrl+Left and Ctrl+Right or the app strip to switch. Each device keeps its own view and focus.

## First useful release

1. On the desktop, open Settings → Host access. Hosting starts off. Pick the private network interface, set an access password, and enable the listener. Show the address, connected devices, and a disconnect control. Offer to keep the host awake while serving. The display can turn off.
2. On the laptop, open the address and enter the password. Agent Sessions opens immediately. Reuse the session list, Claude Code and Codex provider/model choices, transcript, composer, run activity, questions, and permissions. List and resume the same sessions, start new ones in a host project, send a follow-up, stop a turn, or answer a request.
3. Refresh, close the laptop lid, or lose Wi-Fi during a run. The run continues on the desktop. Reconnect to the same transcript, pending requests, and run state. If the host is unavailable, keep the unsent text visible and disable actions until the connection is restored.
4. Once the two-device Agent Sessions workflow passes, add apps behind explicit adapters. Start with UI Maker review and comparison, then add editing. Browser and Terminal follow with host-side webview and PTY adapters. Each adapter declares the actions it supports and which require confirmation.

The two Lab variants cover the laptop and the desktop settings. Host settings appear in the laptop mock as a preview shortcut. In the product, settings that start or stop the listener stay on the desktop.

## Backend boundary

- Keep the desktop server and private MCP bridge on loopback. The current agent API enforces local, same-origin access in `server/agent-sessions-api.ts`. Add a dedicated LAN listener with a small, explicit route table and reuse the runner behind it. Serve the focused Vue shell and its API from one HTTPS origin. Test certificate setup on two physical machines before selecting the default: a trusted local certificate provisioned to the laptop or a user-provided certificate. Bind only to the selected interface and scope the Windows firewall rule to the private subnet. [OWASP session management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)
- Store a salted password verifier on the desktop. Rate-limit sign-in. Issue revocable, expiring sessions via Secure, HttpOnly, SameSite cookies. Check the session and capability on every route, stream, and asset. Validate Host and Origin and require a session-bound token on mutations. Turning hosting off or changing the password revokes access and ends streams. First release uses no public relay or port forwarding. [OWASP authentication](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html) · [OWASP CSRF prevention](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)
- Reuse the host's agent request and event flow behind typed session operations. Give each send a client request ID, deduplicate on the host, and serialize conflicting operations for the same conversation. Stream a snapshot followed by ordered updates. Reconnect from a cursor when possible, or refetch a snapshot. Reject a second reply to an already answered approval. Keep provider secrets, raw transcript paths, arbitrary filesystem routes, the MCP bridge, and Electron privileges out of the LAN route table.
- Keep established provider approval modes. Start remote sessions with the host's allowed project roots. A remote browser should be able to answer an eligible approval with the action and target visible. Privilege escalation and raw terminal input need distinct host settings before their adapters are enabled. Render transcript Markdown as untrusted content. Serve arbitrary UI Maker HTML on an isolated preview origin with no access to remote session cookies.
- Keep one host workspace writer. Remote app changes use the same host commands and revisions as the desktop. A second browser never takes the desktop's editing lease. Persist app changes through the host, while leaving each browser's active app, scroll, and draft state local to that view.

## Delegation between providers

The current **Continue with another model** command creates an editable draft with source context. The user sends it. The connector exposes UI Maker and other domain tools but has no tool for opening a second Claude Code or Codex session and assigning it a brief.

Build delegation after the remote session API proves the host execution path. A typed tool can create a separate, linked session using an explicitly selected provider/model, project, and permission preset. Return a session ID immediately. Expose status, follow-up, stop, and result retrieval while routing permission requests to the desktop and laptop. Give each delegation a request ID and disallow recursive delegation in the first release. Verify that a Codex coordinator can give Claude a UI Maker brief, that Claude can publish a Lab variant through the existing MCP tools, and that Codex can review the result and continue the backend work. Approval handling and usage remain visible on both machines.

## Acceptance on two machines

- An unauthenticated laptop can load the sign-in page only. Direct transcript, stream, asset, and action requests fail. A second network and a disabled host cannot reach the service.
- Start a Claude Code task on the desktop, resume it from the laptop, send a Codex follow-up in a separate session, and answer a real approval from the laptop. Verify the desktop shows the same changes and the laptop contains no provider credentials.
- Drop Wi-Fi between sending and receiving acknowledgement. Reconnect and confirm one user turn, one run, and the correct pending approval or completion. Try a rejected action, a stale approval, and host shutdown while the laptop is open.
- On the actual small laptop, keep chat readable at browser zoom and navigate with Ctrl+Left/Right without interrupting cursor movement in the composer. Check both host sleep settings and the laptop closing its lid during a turn.
