/**
 * One paragraph about GitHub, present only when a token is (GH_TOKEN from the
 * desktop's GitHub card, or GITHUB_TOKEN from the shell). Without it the model
 * treats GitHub as out of reach while an authenticated `gh` sits in bash.
 */
export const githubPrompt = (): string | null => {
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? "";

  if (token.trim().length === 0) return null;

  return [
    "## GitHub",
    "",
    "A GitHub token is in the environment, so the `gh` CLI (and git over HTTPS)",
    "is already authenticated — private repositories included, as far as the",
    "token's scopes reach. Use `gh` from bash for GitHub work: `gh repo clone`,",
    "`gh pr list/create/view`, `gh issue …`, `gh api …` for anything else. If",
    "`gh` is not installed, fall back to `git` with",
    "https://x-access-token:$GH_TOKEN@github.com/OWNER/REPO.git — and never",
    "print or echo the token itself.",
  ].join("\n");
};
