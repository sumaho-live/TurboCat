# Publishing TurboCat to the VS Code Marketplace

This guide explains how to register for the Visual Studio Code Marketplace and prepare the credentials that the CI workflow requires.

## 1. Prepare your Microsoft identity
1. Sign in or create a Microsoft account at [https://login.live.com](https://login.live.com).
2. Enable two-factor authentication for the account to satisfy Marketplace security requirements.

## 2. Create an Azure DevOps organization
1. Visit [https://dev.azure.com](https://dev.azure.com) and sign in with the Microsoft account from the previous step.
2. Create a new Azure DevOps organization if you do not already have one. Any name works; it only hosts the publisher identity.
3. Complete the short onboarding questionnaire and choose a region.

## 3. Register a Visual Studio Marketplace publisher
1. Open the Marketplace management portal at [https://aka.ms/vsmarketplace-manage](https://aka.ms/vsmarketplace-manage).
2. Click **New Publisher** and sign in with the same Microsoft/Azure DevOps account.
3. Provide the publisher name (`Awei` for this project), display name, and contact information. The publisher ID must match the `publisher` field in `package.json`.
4. Accept the terms of service. Verification can take a few minutes; you will receive a confirmation email when the publisher is active.

## 4. Generate a Personal Access Token (PAT)
1. In Azure DevOps, open **User settings → Personal access tokens**.
2. Create a new token with the **Marketplace (Manage)** scope. No other scopes are required.
3. Choose an expiration period that matches your security policy and copy the token value. You will not be able to view it again later.

## 5. Configure GitHub secrets
1. In the GitHub repository, navigate to **Settings → Secrets and variables → Actions**.
2. Create a new repository secret named `VSCE_PAT` and paste the PAT value from the previous step.
3. (Optional) Store additional secrets such as `VSCE_PUBLISHER` if you plan to override the publisher ID from the workflow.

## 6. Triggering a release
1. Push your changes to the `main` branch.
2. Tag the commit with `release=1` (for example: `git tag release=1 && git push origin main --tags`).
3. The GitHub Actions workflow will compile the extension, package a `.vsix` artifact, and publish it to the Marketplace when the `release=1` tag points to the latest `main` commit.

## Troubleshooting tips
- Ensure the `publisher` in `package.json` matches the Marketplace publisher ID exactly.
- The PAT must be active and scoped to **Marketplace (Manage)**. Expired tokens cause a 401 error during publishing.
- Remove the `release=1` tag after publishing if you want to trigger another release later; reusing the same tag requires deleting it locally and remotely before re-creating it.
- To test packaging locally without publishing, run `npm run compile` followed by `npx @vscode/vsce package`.
