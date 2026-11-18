// Spring Prompt check: a GitHub Action with no dependencies.
//
// It sends the pull request's diff to Spring Prompt, which finds every tested prompt whose
// wording the diff changes, runs the new wording on that prompt's test cases and compares the
// answers with the saved ones (POST /api/checks/diff). This waits for the verdicts, writes them
// to the job summary and a pull-request comment, and fails the job on a fail.
"use strict";

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");

const MARKER = "<!-- springprompt-check -->";
const ORDER = { pass: 0, review: 1, fail: 2 };
const MAX_DIFF = 1_500_000; // characters sent, under the server's limit once JSON-escaped
const EXCLUDE = [
  ":(exclude)**/package-lock.json", ":(exclude)**/yarn.lock", ":(exclude)**/pnpm-lock.yaml",
  ":(exclude)**/uv.lock", ":(exclude)**/poetry.lock", ":(exclude)**/Cargo.lock",
  ":(exclude)**/go.sum", ":(exclude)**/*.min.js", ":(exclude)**/*.map",
];

function input(name, fallback = "") {
  const raw = process.env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`];
  return raw === undefined || raw.trim() === "" ? fallback : raw.trim();
}

function list(text) {
  return text.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function has(ref) {
  try {
    git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

function fetch1(sha, depth = 1) {
  try {
    git(["fetch", "--no-tags", "--quiet", `--depth=${depth}`, "origin", sha]);
  } catch {
    // a shallow fetch can be refused; the diff below says what is missing
  }
}

// The commits to compare, from the event: a pull request's base and head, or a push's before
// and after. On a pull request actions/checkout makes a merge commit; its first parent is the
// base branch as it is now, so HEAD^1..HEAD is exactly what merging would change.
function range(event) {
  const pr = event.pull_request;
  if (pr) {
    if (!has("HEAD^1")) fetch1(process.env.GITHUB_SHA || "HEAD", 2);
    if (has("HEAD^1") && git(["rev-list", "--parents", "-n", "1", "HEAD"]).trim().split(" ").length > 2) {
      return ["HEAD^1", "HEAD"];
    }
    const base = pr.base && pr.base.sha;
    const head = (pr.head && pr.head.sha) || "HEAD";
    if (base && !has(base)) fetch1(base);
    if (head !== "HEAD" && !has(head)) fetch1(head);
    return [base, head];
  }
  if (event.before && !/^0+$/.test(event.before)) {
    if (!has(event.before)) fetch1(event.before);
    return [event.before, event.after || "HEAD"];
  }
  if (!has("HEAD^1")) fetch1(process.env.GITHUB_SHA || "HEAD", 2);
  return ["HEAD^1", "HEAD"];
}

function diffOf(from, to) {
  const text = git(["diff", "--no-color", "--no-ext-diff", "-U3", from, to, "--", ".", ...EXCLUDE]);
  return text.length > MAX_DIFF ? text.slice(0, MAX_DIFF) : text;
}

async function call(base, key, method, path, body) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(base + path, {
        method,
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          "User-Agent": "springprompt-action/1",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      if (attempt < 3) { await sleep(3000 * (attempt + 1)); continue; }
      throw new Error(`Could not reach Spring Prompt: ${err.message}`);
    }
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { error: text.slice(0, 300) }; }
    // a deploy on our side answers 502/503 for a moment
    if ((res.status === 502 || res.status === 503 || res.status === 504) && attempt < 3) {
      await sleep(5000 * (attempt + 1));
      continue;
    }
    return { status: res.status, data };
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(base, key, check, until) {
  let got = check;
  while (got.status === "running" && Date.now() < until) {
    const res = await call(base, key, "GET", `/api/checks/${encodeURIComponent(check.id)}?wait=20`);
    if (res.status === 200) got = { ...check, ...res.data };
    else if (res.status !== 429) return { ...check, status: "failed", error: res.data.error || `HTTP ${res.status}` };
    else await sleep(10000);
  }
  if (got.status === "running") return { ...got, status: "timeout", error: "It was still running when the job stopped waiting." };
  return got;
}

// --- The report ---------------------------------------------------------------------------

const LABEL = { pass: "Pass", review: "Review", fail: "Fail" };
const DOCS = "/docs/check-before-merge";

// The verdict card: a picture drawn by Spring Prompt from the verdict and counts alone, so
// nothing of the prompt or its answers is ever in an image address.
function pct(n, of) {
  return of ? `${Math.round((100 * n) / of)}%` : "–";
}

function card(base, check) {
  const n = check.numbers || {};
  if (!check.verdict || !n.cases) return "";
  const side = n.side_by_side && n.side_by_side.n ? n.side_by_side : null;
  const q = new URLSearchParams({
    v: check.verdict, cases: n.cases, before: n.baseline_passed, after: n.candidate_passed,
    better: n.cases_better, worse: n.cases_worse,
    ...(side ? { sn: side.new, ss: side.saved } : {}),
  });
  let alt = `${LABEL[check.verdict] || check.verdict}: ${pct(n.baseline_passed, n.cases)} of ${n.cases} cases passed every must check before the change, ${pct(n.candidate_passed, n.cases)} after.`;
  alt += side ? ` Side by side, the new answer was preferred on ${side.new}, the old on ${side.saved}.` : ` ${n.cases_better} better, ${n.cases_worse} worse.`;
  const img = `<img src="${base}/badge/check.png?${q}" width="600" alt="${escape(alt)}">`;
  return check.url ? `<a href="${check.url}">${img}</a>` : img;
}

function header(base) {
  return `<a href="${base}${DOCS}"><picture><source media="(prefers-color-scheme: dark)" srcset="${base}/static/brand/lockup-dark.svg"><img src="${base}/static/brand/lockup.svg" height="26" alt="Spring Prompt"></picture></a>`;
}

function fence(text) {
  const longest = Math.max(2, ...(String(text).match(/`+/g) || []).map((s) => s.length));
  const ticks = "`".repeat(longest + 1);
  return `${ticks}\n${text}\n${ticks}`;
}

function quote(text) {
  const t = String(text || "").trim() || "(empty)";
  return fence(t);
}

function one(check, base = "") {
  const lines = [];
  const where = check.files && check.files.length ? ` · \`${check.files.join("`, `")}\`` : "";
  const head = check.verdict ? LABEL[check.verdict] || check.verdict : "No verdict";
  lines.push(`### ${head}: ${check.name}${where}`);
  lines.push("");
  if (check.status === "done") {
    const n = check.numbers || {};
    const picture = base ? card(base, check) : "";
    if (picture) lines.push(picture, "");
    if (n.cases && !picture) {
      lines.push(`| Cases | Pass every must check | Better | Worse | Same |`);
      lines.push(`| --- | --- | --- | --- | --- |`);
      lines.push(`| ${n.cases} | ${pct(n.baseline_passed, n.cases)} → ${pct(n.candidate_passed, n.cases)} | ${n.cases_better} | ${n.cases_worse} | ${n.cases_same} |`);
      lines.push("");
    }
    if (check.url) {
      lines.push(`**[Open this check in Spring Prompt →](${check.url})** the test's cases and saved answers, this check's results and fixes (signed in as the test's owner)${check.cost_usd != null ? ` · this check cost $${Number(check.cost_usd).toFixed(2)}` : ""}`, "");
    }
    lines.push(check.summary || "");
    for (const r of (check.reasons || []).slice(1)) lines.push(`- ${r}`);
    const advice = check.advice || {};
    if (advice.why || (advice.fixes || []).length) {
      lines.push("", "#### How to fix it", "");
      if (advice.why) lines.push(advice.why, "");
      for (const f of advice.fixes || []) lines.push(`- ${f.change}${f.because ? `. _${f.because}_` : ""}`);
      lines.push("", "<sub>Suggested by a model from the checks that failed and the answers above. Try one, push, and this check runs again.</sub>");
    }
    const rubrics = n.rubrics || [];
    if (rubrics.length) {
      lines.push("", "#### Rubrics", "", "| Quality | Before | After |", "| --- | --- | --- |");
      for (const r of rubrics) lines.push(`| ${escape(r.check)} | ${r.before} of ${r.top} | ${r.after} of ${r.top} |`);
    }
  } else {
    lines.push(check.error || "There is no verdict. Run the job again.");
  }
  for (const note of check.notes || []) lines.push(`- ${note}`);
  const regressions = check.regressions || [];
  if (regressions.length) {
    lines.push("", `<details><summary>Checks that now fail (${regressions.length})</summary>`, "");
    for (const r of regressions) {
      lines.push(`- Case ${r.case} (${escape(r.input)}): **${r.check}**${r.detail ? `: ${r.detail}` : ""}`);
    }
    lines.push("", "</details>");
  }
  if (check.diff) {
    lines.push("", "<details><summary>What changed in the prompt</summary>", "", fence(check.diff).replace(/^```+/, (m) => m + "diff"), "", "</details>");
  }
  for (const e of check.examples || []) {
    const what = { worse: "got worse", better: "got better", different: "changed" }[e.change] || "changed";
    lines.push("", `<details><summary>Case ${e.case} ${what}: ${escape(e.input)}</summary>`, "");
    lines.push("**Before**", "", quote(e.before), "", "**After**", "", quote(e.after));
    if (e.cut) lines.push("", "_Answers shortened._");
    lines.push("", "</details>");
  }
  return lines.join("\n");
}

function escape(text) {
  return String(text || "").replace(/[<>]/g, (c) => (c === "<" ? "&lt;" : "&gt;")).slice(0, 200);
}

function report(started, done, base = "") {
  const lines = [MARKER, base ? header(base) : "## Spring Prompt check", ""];
  if (!done.length) {
    lines.push(started.summary || "No tested prompt's wording changed in this pull request.");
  }
  for (const c of done) lines.push(one(c, base), "");
  const skipped = started.skipped || [];
  if (skipped.length) {
    lines.push("**Not checked**", "");
    for (const s of skipped) lines.push(`- ${s.name}: ${s.reason}`);
    lines.push("");
  }
  const unplaced = started.unplaced || [];
  if (unplaced.length) {
    lines.push("**Changed files that call a tested prompt, with no change to its wording found**", "");
    for (const u of unplaced) lines.push(`- ${u.name} (\`${u.where}\`): ${u.reason}`);
    lines.push("");
  }
  const docs = base ? `<a href="${base}${DOCS}">Spring Prompt prompt check</a>` : "Spring Prompt prompt check";
  lines.push("---", `<sub>${docs} · held ${started.scanned ?? 0} tested prompt${started.scanned === 1 ? "" : "s"} to this diff, on your own test cases. The comment updates on each push.</sub>`);
  return lines.join("\n");
}

function worst(done) {
  let out = "";
  for (const c of done) {
    const v = c.verdict || "fail";
    if (!out || ORDER[v] > ORDER[out]) out = v;
  }
  return out;
}

// --- GitHub -----------------------------------------------------------------------------

async function comment(token, event, body) {
  const pr = event.pull_request;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!pr || !token || !repo) return "no pull request";
  const api = process.env.GITHUB_API_URL || "https://api.github.com";
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "springprompt-action/1",
    "Content-Type": "application/json",
  };
  const base = `${api}/repos/${repo}/issues/${pr.number}/comments`;
  let found = null;
  for (let page = 1; page <= 10 && !found; page++) {
    const res = await fetch(`${base}?per_page=100&page=${page}`, { headers });
    if (!res.ok) return `could not read comments (HTTP ${res.status})`;
    const rows = await res.json();
    found = rows.find((c) => typeof c.body === "string" && c.body.startsWith(MARKER)) || null;
    if (rows.length < 100) break;
  }
  const text = body.length > 65000 ? body.slice(0, 64900) + "\n\n_Cut to fit a comment._" : body;
  const res = found
    ? await fetch(`${api}/repos/${repo}/issues/comments/${found.id}`, { method: "PATCH", headers, body: JSON.stringify({ body: text }) })
    : await fetch(base, { method: "POST", headers, body: JSON.stringify({ body: text }) });
  return res.ok ? "" : `could not post the comment (HTTP ${res.status}); give the job pull-requests: write`;
}

function output(name, value) {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

function summary(text) {
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + "\n");
}

function annotate(level, text) {
  console.log(`::${level}::${String(text).replace(/\r?\n/g, " ")}`);
}

async function main() {
  const key = input("key");
  const event = process.env.GITHUB_EVENT_PATH ? JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")) : {};
  if (!key) {
    // pull requests from forks get no secrets: say so and pass, rather than fail them all
    annotate("notice", "No Spring Prompt key, so nothing was checked. Pull requests from forks cannot read repository secrets.");
    output("verdict", "none");
    return 0;
  }
  const base = input("base-url", "https://springprompt.com").replace(/\/+$/, "");
  const failOn = input("fail-on", "fail") === "review" ? "review" : "fail";
  const until = Date.now() + Number(input("timeout-minutes", "20")) * 60_000;
  const [from, to] = range(event);
  if (!from) throw new Error("Could not tell which commits to compare. Use actions/checkout with fetch-depth: 2 or more.");
  const diff = diffOf(from, to);
  const pr = event.pull_request;
  const label = pr ? `PR #${pr.number}: ${pr.title || ""}`.slice(0, 120) : `${process.env.GITHUB_REF_NAME || ""} ${String(to).slice(0, 7)}`.trim();
  const body = { diff, label, test_ids: list(input("test-ids")) };
  const spend = input("max-spend-usd");
  if (spend) body.max_spend_usd = Number(spend);
  console.log(`Sending the diff (${diff.length} characters, ${from.slice(0, 12)}..${String(to).slice(0, 12)}) to ${base}`);
  const res = await call(base, key, "POST", "/api/checks/diff", body);
  if (res.status !== 200 && res.status !== 202) {
    throw new Error(`Spring Prompt refused the check (HTTP ${res.status}): ${res.data.error || "no reason given"}`);
  }
  const started = res.data;
  console.log(started.summary);
  const done = await Promise.all((started.checks || []).map((c) => waitFor(base, key, c, until)));
  const text = report(started, done, base);
  summary(text);
  console.log(text);
  if (input("comment", "true") !== "false" && (done.length || (started.unplaced || []).length)) {
    const problem = await comment(input("github-token"), event, text);
    if (problem && problem !== "no pull request") annotate("warning", `Spring Prompt: ${problem}`);
  }
  const verdict = worst(done);
  output("verdict", verdict || "none");
  output("checks", String(done.length));
  let failed = false;
  for (const c of done) {
    const where = `${c.name}: ${c.summary || c.error || ""} ${c.url || ""}`.trim();
    if (!c.verdict) { annotate("error", `No verdict. ${where}`); failed = true; }
    else if (c.verdict === "fail") { annotate("error", where); failed = true; }
    else if (c.verdict === "review") { annotate(failOn === "review" ? "error" : "warning", where); failed ||= failOn === "review"; }
  }
  return failed ? 1 : 0;
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (err) => { annotate("error", err.message); process.exit(1); },
  );
}

module.exports = { report, worst, one, range, diffOf, list, MARKER };
