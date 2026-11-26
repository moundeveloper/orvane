import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cancelLogin, claimLogin, issueLogin, loginActive } from "../server/claude-login.ts";

test("cancelling a running login retains the account reservation until the PTY exits", () => {
  const scope = randomUUID();
  const ticket = issueLogin(scope, "work", "Work", { file: process.execPath, args: [] }, {}, process.cwd(), () => {});
  const claimed = claimLogin(ticket)!;
  let killed = 0;
  claimed.started(() => { killed++; });
  try {
    assert.equal(cancelLogin(scope, "work"), true);
    assert.equal(killed, 1);
    assert.equal(loginActive(scope, "work"), true, "Runs must stay blocked while the login process is terminating");
    assert.throws(() => issueLogin(scope, "work", "Work", { file: process.execPath, args: [] }, {}, process.cwd(), () => {}), /already open/);
  } finally {
    claimed.ended(null);
  }
  assert.equal(loginActive(scope, "work"), false);
});

test("an unused login ticket can be cancelled without claiming or spawning it", () => {
  const scope = randomUUID();
  let ended = 0;
  const ticket = issueLogin(scope, "work", "Work", { file: process.execPath, args: [] }, {}, process.cwd(), () => { ended++; });
  assert.equal(cancelLogin(scope, "work"), true);
  assert.equal(loginActive(scope, "work"), false);
  assert.equal(claimLogin(ticket), null);
  assert.equal(ended, 1);
});
