# Agent rules

Rules for any AI agent working in this repository.

## 1. Git & Workflow

- **Stay on `master`:** Commit directly to `master`. Create branches only when specifically asked.
- **Casual Commits:** Write short, natural commit messages using informal American phrasing.
  Auto-commit and push on sync.

## 2. Running, Testing & Clean Code

- **Run Only Related Tests:** Test only what was touched. Skip tests for minor edits; never run the
  whole test suite.
- **Zero Warnings:** Fix all build warnings immediately. Treat every warning as a failure.
- **Restart After Changes:** Restart the app after a code change and verify it comes back up.
- **No User Secrets:** Do not use `dotnet user-secrets`. Put local data in `appsettings` or in
  Azure Key Vault (if one exists).

## 3. Architecture & Setup

- **Keep Docs Updated:** Check `DOCS/` and `README.md` first to get an overview of the app quickly.
  When a dependency, a configuration key or a major endpoint changes, update them in the same
  change.
- **Fully Automated:** Run all builds, scripts, and setup commands directly. Do not ask the user to
  run terminal commands or click through a web GUI.

## 4. UI & Output Rules

- **UI Previews:** For visual changes, save before-and-after HTML mockups to
  `SCREENSHOTS/{YYMMDD}-{feature}.html`, and annotate screenshots showing the before and after with
  notes in a single PNG. Give the full path.
- **Clarifying Questions:** If modifying more than 100 lines and no pending questions exist, list 3
  key follow-up questions about future direction or logic.
- **Required Footers:**
  - **Short Recap:** If your response is over 100 words, add a recap under 20 words at the very end.
  - **3-Level Summary:** If a code change is over 20 lines, add 3 single-sentence summaries:
    - *Toddler:* Explain the idea simply.
    - *Child:* Explain what the app actually does now.
    - *Adult:* Explain how it was built.

## CI/CD and Azure (same section in every Po repo)

- A push to `master` builds, tests, deploys and health-gates (`.github/workflows/deploy.yml`). Nothing is deployed by hand.
- Azure sign-in is GitHub OIDC (the `gh-<repo>-deploy` app). Its IDs are repo **variables** `AZURE_CLIENT_ID`, `AZURE_TENANT_ID` and `AZURE_SUBSCRIPTION_ID`, and the App Service name is `AZURE_WEBAPP_NAME`. Never move them to secrets or write resource names into workflows.
- Every permission the app and CI need lives in `scripts/ensure-azure-access.ps1`. A role granted by hand and not added there is a bug: the next re-provision loses it.
- The app answers `/health/live` (process up, no dependencies) and `/health` (dependencies reachable). The deploy's health gate checks both.
- Tests pass on any machine: no drive-letter, temp-folder or working-directory assumptions, and no live config value hard-coded as an expected result (read it from the same config the app reads).
- A red run on the default branch gets an ntfy push from the CI watcher in PoPunkouterSoftware. Fix it, or say why it is red.
