// The action end to end: a real git repository, a stand-in Spring Prompt and a stand-in GitHub,
// and the action run as the runner runs it (node index.js with INPUT_* and GITHUB_* set).
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync, spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { report, worst, MARKER } = require("../index.js");

const ACTION = path.join(__dirname, "..", "index.js");

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sp-action-"));
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  fs.writeFileSync(path.join(dir, "bot.py"), 'SYSTEM = "Reply to the customer. Be brief."\n');
  git("add", ".");
  git("commit", "-q", "-m", "one");
  const before = git("rev-parse", "HEAD");
  fs.writeFileSync(path.join(dir, "bot.py"), 'SYSTEM = "Reply to the customer. Be brief and kind."\n');
  git("commit", "-q", "-am", "two");
  return { dir, before, after: git("rev-parse", "HEAD") };
}

function server(handler) {
  return new Promise((resolve) => {
    const seen = [];
    const s = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const got = { method: req.method, url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null };
        seen.push(got);
        const [status, data] = handler(got, seen);
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
      });
    });
    s.listen(0, "127.0.0.1", () => resolve({ s, seen, url: `http://127.0.0.1:${s.address().port}` }));
  });
}

function run(env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [ACTION], { env: { PATH: process.env.PATH, ...env }, cwd: env.CWD });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => resolve({ code, out }));
  });
}

const DONE = {
  id: "t1.abc", test_id: "t1", status: "done", verdict: "fail", name: "Support reply",
  files: ["bot.py"], summary: "1 must check that passed on the baseline failed on the candidate, on 1 case.",
  reasons: ["1 must check that passed on the baseline failed on the candidate, on 1 case."],
  numbers: { cases: 10, baseline_passed: 10, candidate_passed: 9, cases_better: 1, cases_worse: 2, cases_same: 7 },
  regressions: [{ case: 4, input: "ticket=Where is my order?", check: "Under 60 words", detail: "It ran to 85 words." }],
  examples: [{ case: 4, input: "ticket=Where is my order?", change: "worse", before: "It ships today.", after: "Thanks so much for reaching out! ...", cut: false }],
  url: "https://springprompt.com/app/prompt/t1?check=abc#checks", cost_usd: 0.04,
};

test("a fail is reported, commented on the pull request, and fails the job", async () => {
  const { dir, before, after } = repo();
  const sp = await server((req) => {
    if (req.method === "POST" && req.url === "/api/checks/diff") {
      return [202, { checks: [{ ...DONE, status: "running", verdict: undefined, diff: "-Be brief.\n+Be brief and kind." }], skipped: [], unplaced: [], scanned: 3, summary: "Checking 1 changed prompt." }];
    }
    if (req.method === "GET" && req.url.startsWith("/api/checks/t1.abc")) return [200, DONE];
    return [404, { error: "no" }];
  });
  const gh = await server((req) => (req.method === "GET" ? [200, []] : [201, { id: 1 }]));
  const event = path.join(dir, "event.json");
  // a pull_request event without a merge commit: the action compares base and head
  fs.writeFileSync(event, JSON.stringify({ pull_request: { number: 7, title: "Kinder replies", base: { sha: before }, head: { sha: after } } }));
  const summaryFile = path.join(dir, "summary.md");
  const outputFile = path.join(dir, "out.txt");
  const got = await run({
    CWD: dir, INPUT_KEY: "sk_test", "INPUT_BASE-URL": sp.url, "INPUT_GITHUB-TOKEN": "ghs_x",
    GITHUB_EVENT_PATH: event, GITHUB_REPOSITORY: "acme/app", GITHUB_API_URL: gh.url,
    GITHUB_STEP_SUMMARY: summaryFile, GITHUB_OUTPUT: outputFile,
  });
  sp.s.close();
  gh.s.close();
  assert.equal(got.code, 1, got.out);
  const sent = sp.seen[0];
  assert.equal(sent.headers.authorization, "Bearer sk_test");
  assert.match(sent.body.diff, /\+SYSTEM = "Reply to the customer\. Be brief and kind\."/);
  assert.equal(sent.body.label, "PR #7: Kinder replies");
  assert.match(got.out, /::error::Support reply: 1 must check/);
  const posted = gh.seen.find((r) => r.method === "POST");
  assert.equal(posted.url, "/repos/acme/app/issues/7/comments");
  assert.ok(posted.body.body.startsWith(MARKER));
  assert.match(posted.body.body, /### Fail: Support reply/);
  // branded: the lockup, the verdict card (counts only, linked to the full results), a footer
  assert.match(posted.body.body, new RegExp(`<img src="${sp.url}/static/brand/lockup.svg"`));
  assert.match(posted.body.body, /lockup-dark\.svg/);
  assert.match(posted.body.body, /<a href="https:\/\/springprompt\.com\/app\/prompt\/t1\?check=abc#checks"><img src="http:\/\/127\.0\.0\.1:\d+\/badge\/check\.png\?v=fail&cases=10&before=10&after=9&better=1&worse=2"/);
  assert.doesNotMatch(posted.body.body, /Where is my order\?[^\n]*badge/);  // no case text in an image address
  assert.match(posted.body.body, /Spring Prompt prompt check<\/a> · held 3 tested prompts/);
  assert.match(posted.body.body, /It ships today\./);
  assert.match(fs.readFileSync(summaryFile, "utf8"), /badge\/check\.png\?v=fail/);
  assert.match(fs.readFileSync(outputFile, "utf8"), /verdict=fail/);
});

test("an existing comment is updated, and review passes unless fail-on is review", async () => {
  const { dir, before, after } = repo();
  const review = { ...DONE, verdict: "review", regressions: [] };
  const sp = await server((req) => (req.method === "POST"
    ? [200, { checks: [review], skipped: [], unplaced: [], scanned: 1, summary: "" }]
    : [200, review]));
  const gh = await server((req) => (req.method === "GET"
    ? [200, [{ id: 99, body: `${MARKER}\nold` }]]
    : [200, { id: 99 }]));
  const event = path.join(dir, "event.json");
  fs.writeFileSync(event, JSON.stringify({ pull_request: { number: 8, base: { sha: before }, head: { sha: after } } }));
  const env = { CWD: dir, INPUT_KEY: "k", "INPUT_BASE-URL": sp.url, "INPUT_GITHUB-TOKEN": "t",
    GITHUB_EVENT_PATH: event, GITHUB_REPOSITORY: "acme/app", GITHUB_API_URL: gh.url };
  const passed = await run(env);
  assert.equal(passed.code, 0, passed.out);
  assert.match(passed.out, /::warning::Support reply/);
  assert.ok(gh.seen.some((r) => r.method === "PATCH" && r.url === "/repos/acme/app/issues/comments/99"));
  const strict = await run({ ...env, "INPUT_FAIL-ON": "review" });
  assert.equal(strict.code, 1, strict.out);
  sp.s.close();
  gh.s.close();
});

test("without a key (a fork's pull request) nothing is sent and the job passes", async () => {
  const { dir } = repo();
  const got = await run({ CWD: dir });
  assert.equal(got.code, 0);
  assert.match(got.out, /::notice::No Spring Prompt key/);
});

test("a push compares before and after", async () => {
  const { dir, before, after } = repo();
  const sp = await server(() => [200, { checks: [], skipped: [], unplaced: [], scanned: 2, summary: "No tested prompt's wording changed in this diff." }]);
  const event = path.join(dir, "event.json");
  fs.writeFileSync(event, JSON.stringify({ before, after }));
  const got = await run({ CWD: dir, INPUT_KEY: "k", "INPUT_BASE-URL": sp.url, GITHUB_EVENT_PATH: event, GITHUB_REF_NAME: "main" });
  sp.s.close();
  assert.equal(got.code, 0, got.out);
  assert.match(sp.seen[0].body.diff, /Be brief and kind/);
  assert.match(got.out, /No tested prompt's wording changed/);
});

test("a refusal fails the job with the server's reason", async () => {
  const { dir, before, after } = repo();
  const sp = await server(() => [402, { error: "Not enough credit." }]);
  const event = path.join(dir, "event.json");
  fs.writeFileSync(event, JSON.stringify({ before, after }));
  const got = await run({ CWD: dir, INPUT_KEY: "k", "INPUT_BASE-URL": sp.url, GITHUB_EVENT_PATH: event });
  sp.s.close();
  assert.equal(got.code, 1);
  assert.match(got.out, /::error::Spring Prompt refused the check \(HTTP 402\): Not enough credit\./);
});

test("the report and the worst verdict", () => {
  assert.equal(worst([{ verdict: "pass" }, { verdict: "review" }]), "review");
  assert.equal(worst([{ verdict: "pass" }, { status: "failed" }]), "fail");
  const text = report({ scanned: 1, skipped: [{ name: "Triage", reason: "The test is running." }], unplaced: [] }, []);
  assert.match(text, /Not checked/);
  assert.match(text, /Triage: The test is running\./);
});

test("without Spring Prompt's address the report falls back to a plain table", () => {
  const text = report({ scanned: 1 }, [DONE]);
  assert.match(text, /## Spring Prompt check/);
  assert.match(text, /\| 10 \| 10 → 9 \| 1 \| 2 \| 7 \|/);
  assert.doesNotMatch(text, /<img/);
});
