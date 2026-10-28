# Agent rules

Rules for any AI agent working in this repository.

## Branches and git

- Only use the `master` branch for all work. Use another branch only when specifically asked to.
- When a git sync happens, create a git commit and also push the code. Keep the commit message
  short, in American slang and not technical, so it reads as if a human wrote it.

## Making changes

- Always restart the app after a code change and verify it restarts successfully.
- Treat compile warnings as errors and make sure they are fixed.
- Do not run all tests after a code change. Run only the tests related to the change, or no tests
  at all if the change is simple.
- Do not use `dotnet user-secrets` to store data locally. Put it in `appsettings` or in Azure Key
  Vault (if one exists).
- Avoid making the user type commands into the CLI or click through a web GUI by hand when you can
  do it for them automatically.

## Finding your way

- Check the `DOCS` folder in the repository root and `README.md` first for an overall summary of
  the project and its architecture.
- Keep both up to date: whenever a dependency, a configuration key or a major endpoint changes,
  update `DOCS` and `README.md` in the same change.

## Reporting back

- At the end of any answer longer than 100 words, add a TLDR summary of about 20 words.
- If more than 100 lines of code are removed overall in one prompt, mention it.
- When a change to the UI is made, take an annotated screenshot showing the old and the new UI
  with the changes marked. Save it as `SCREENSHOTS/YYMMDD-feature-name.html` (for example
  `SCREENSHOTS/261017-score-panel.html`) and give its valid full path.
- When a code change is longer than 20 lines, add a three-line summary at the end, one line per
  level:
  1. Toddler: one sentence giving the simple idea behind the change.
  2. Child: one sentence on what it now does.
  3. Adult: one sentence on the technical or architectural change.

## CI/CD and Azure (same section in every Po repo)

- A push to `master` builds, tests, deploys and health-gates (`.github/workflows/deploy.yml`). Nothing is deployed by hand.
- Azure sign-in is GitHub OIDC (the `gh-<repo>-deploy` app). Its IDs are repo **variables** `AZURE_CLIENT_ID`, `AZURE_TENANT_ID` and `AZURE_SUBSCRIPTION_ID`, and the App Service name is `AZURE_WEBAPP_NAME`. Never move them to secrets or write resource names into workflows.
- Every permission the app and CI need lives in `scripts/ensure-azure-access.ps1`. A role granted by hand and not added there is a bug: the next re-provision loses it.
- The app answers `/health/live` (process up, no dependencies) and `/health` (dependencies reachable). The deploy's health gate checks both.
- Tests pass on any machine: no drive-letter, temp-folder or working-directory assumptions, and no live config value hard-coded as an expected result (read it from the same config the app reads).
- A red run on the default branch gets an ntfy push from the CI watcher in PoPunkouterSoftware. Fix it, or say why it is red.
