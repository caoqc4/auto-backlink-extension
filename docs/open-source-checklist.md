# Open Source Checklist

Use this before switching the repository to public.

## Required

- [ ] Delete or sanitize captured requests, cookies, and session-bearing files.
- [ ] Keep private research exports such as `doc_webcafe/` out of git.
- [ ] Confirm `README.md` accurately describes current setup and extension permissions.
- [ ] Confirm the chosen license in `LICENSE`.
- [ ] Run `npm run build`.
- [ ] Run a final secret scan:

```bash
rg -n "(cookie|authorization|bearer|secret|token|api[_-]?key|password)" -S . -g '!*node_modules*' -g '!package-lock.json'
```

## Recommended

- [ ] Decide whether broad `<all_urls>` host access is acceptable for the public version.
- [ ] Add screenshots or a short demo GIF after private project data is removed.
- [ ] Add GitHub repository metadata: description, topics, license, and issue settings.
- [ ] Tag an initial release after loading and testing the built `dist` extension in Chrome.
