# Spring Prompt check

A GitHub Action that tests how a pull request's prompt changes move your app's answers, on your own test cases, and fails the job when they get worse.

Change a sentence in a prompt, open a pull request, and the action:

1. sends the diff to [Spring Prompt](https://springprompt.com), which finds every prompt you have tested whose wording the diff changes (in code, in a `.md` or `.txt` file, anywhere);
2. runs the new wording on that prompt's test cases, on the model your app uses, and marks the answers with the prompt's checks;
3. compares them with the saved answers and gives a verdict: **pass**, **review** or **fail**;
4. comments on the pull request with the verdict, the wording before and after, and the cases whose answers changed, side by side. The comment is updated on each push.

The job fails on `fail`, so a prompt change that breaks a case cannot be merged without someone looking.

## Use it

```yaml
# .github/workflows/prompt-check.yml
name: Prompt check
on: pull_request

permissions:
  contents: read
  pull-requests: write

jobs:
  check:
    runs-on: ubuntu-latest
    timeout-minutes: 25
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 2
      - uses: incremento/springprompt-action@v1
        with:
          key: ${{ secrets.SPRINGPROMPT_KEY }}
```

Add an account key from **Connect your agent** in the Spring Prompt app as the repository secret `SPRINGPROMPT_KEY`.

Your prompts need a test to be held to. If your app sends its calls to Spring Prompt (`npx springprompt init` or `pip install springprompt`), every prompt we have tested has one. Or name saved Prompt tests with `test-ids`.

## Inputs

| Input | Default | What it does |
| --- | --- | --- |
| `key` | | Your Spring Prompt account key. Required. |
| `test-ids` | | Saved Prompt tests to hold the diff against as well, comma separated. |
| `fail-on` | `fail` | `review` fails the job on a review verdict too. |
| `comment` | `true` | `false` writes only the job summary. |
| `max-spend-usd` | | The most one check may cost. Your account's own limits apply as well. |
| `timeout-minutes` | `20` | How long to wait for the verdicts. |
| `base-url` | `https://springprompt.com` | |
| `github-token` | `github.token` | Posts the comment. Needs `pull-requests: write`. |

Outputs: `verdict` (the worst of `pass`, `review`, `fail`, or `none`) and `checks` (how many prompts were checked).

## What the verdicts mean

- **fail**: a must check that passed on the saved answers fails with the new wording, on any case, or quality dropped by more than chance would explain.
- **review**: something got worse, but by an amount chance could explain on this many cases. The job passes with a warning.
- **pass**: neither.

Full details, limits and costs: [springprompt.com/docs/check-before-merge](https://springprompt.com/docs/check-before-merge).

## Good to know

- A check costs credit, about what running your test once on one model costs. Nothing is spent when no tested prompt changed.
- Pull requests from forks cannot read repository secrets, so for them the action checks nothing and passes.
- The diff is sent to Spring Prompt to find the changes (lock files and minified files left out) and is not kept.
- This action has no dependencies: `index.js` is the whole of it. Its tests: `node --test test/`.

MIT licence.
