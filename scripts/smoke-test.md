# Live smoke test

Use the fixed live contract:

```bash
npm run build
npm run acceptance
```

The contract creates one Git-ignored development vault and one private Obsidian
profile. It checks these behaviors:

1. The server exposes exactly 20 tools.
2. `obsidian_open` binds the selected vault without using the default profile.
3. CLI commands and main-renderer evaluation reach that vault.
4. `obsidian_status` distinguishes the main window and popouts.
5. `obsidian_snapshot` returns window-scoped refs.
6. Browser input and screenshots reach the selected window.
7. `browser_handle_dialog` queues a one-shot response for JavaScript prompt.
8. Alert and confirm dialogs are outside the public contract and dismiss automatically.
9. `obsidian_logs` tails by cursor and identifies the source window.
10. Tool failures return actionable error details.
11. `obsidian_close` stops the private profile and keeps the development vault.

`npm run e2e`, `npm run fence`, `npm run bg-input`, and `npm run workspaces`
run this same contract. The fixed product surface no longer has feature modes or
separate workspace variants.
