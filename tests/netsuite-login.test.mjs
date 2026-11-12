import { test } from "node:test";
import assert from "node:assert/strict";
import {
  autoLoginAccount,
  autoLoginCandidates,
  netSuiteLogin,
  netSuiteSignedIn,
} from "../electron/netsuite-login.mjs";

test("NetSuite auto sign-in matches genuine login pages only", () => {
  assert.deepEqual(netSuiteLogin("https://1964539-sb1.app.netsuite.com/app/login/secure/enterpriselogin.nl"), {
    origin: "https://1964539-sb1.app.netsuite.com",
    account: "1964539-sb1",
  });
  assert.deepEqual(netSuiteLogin("https://system.netsuite.com/pages/customerlogin.jsp?c=1964539_SB2"), {
    origin: "https://system.netsuite.com",
    account: "1964539-sb2",
  });
  assert.deepEqual(netSuiteLogin("https://4027610-sb1.app.netsuite.com/pages/customerlogin.jsp?country=US"), {
    origin: "https://4027610-sb1.app.netsuite.com",
    account: "4027610-sb1",
  });
  for (const url of [
    "http://1964539-sb1.app.netsuite.com/app/login/secure/enterpriselogin.nl",
    "https://1964539-sb1.app.netsuite.com:8443/app/login/secure/enterpriselogin.nl",
    "https://system.netsuite.com.evil.test/pages/customerlogin.jsp",
    "https://evil.test/system.netsuite.com/app/login/",
    "https://1964539-sb1.app.netsuite.co/app/login/secure/enterpriselogin.nl",
    "https://a.b.app.netsuite.com/app/login/secure/enterpriselogin.nl",
    "https://user:pw@system.netsuite.com/pages/customerlogin.jsp",
    "https://1964539-sb1.app.netsuite.com/app/center/card.nl",
    "https://netsuite.com/app/login/",
    "not a url",
  ])
    assert.equal(netSuiteLogin(url), undefined, url);
  assert.equal(netSuiteSignedIn("https://1964539-sb1.app.netsuite.com/app/center/card.nl"), true);
  assert.equal(netSuiteSignedIn("https://1964539-sb1.app.netsuite.com/app/login/secure/twofactor.nl"), false);
  assert.equal(netSuiteSignedIn("https://system.netsuite.com/app/center/card.nl"), false);
});

test("NetSuite auto sign-in covers sandboxes and listed accounts, most recent login first", () => {
  assert.equal(autoLoginAccount("1964539-sb1"), true);
  assert.equal(autoLoginAccount("7654321-sb3"), true);
  assert.equal(autoLoginAccount("1964539"), true);
  assert.equal(autoLoginAccount("7654321"), false);
  assert.equal(autoLoginAccount("7654321-rp"), false);
  assert.equal(autoLoginAccount(undefined), false);

  const logins = [
    { id: "a", origin: "https://1964539-sb1.app.netsuite.com", updated: 1 },
    { id: "b", origin: "https://system.netsuite.com", updated: 2, used: 5 },
    { id: "c", origin: "https://7654321-sb1.app.netsuite.com", updated: 9 },
    { id: "d", origin: "https://1964539.app.netsuite.com", updated: 3, autoLogin: false },
    { id: "e", origin: "https://example.com", updated: 10 },
  ];
  const page = { origin: "https://1964539-sb2.app.netsuite.com", account: "1964539-sb2" };
  assert.deepEqual(autoLoginCandidates(logins, page).map((l) => l.id), ["b", "a"]);
  // system.netsuite.com with no account: any saved NetSuite login.
  const system = { origin: "https://system.netsuite.com", account: undefined };
  assert.deepEqual(autoLoginCandidates(logins, system).map((l) => l.id), ["c", "b", "a"]);
});
