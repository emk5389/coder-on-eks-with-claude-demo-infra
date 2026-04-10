# coder-and-claude-on-eks-demo-infra

CDK package that deploys Coder on EKS with Karpenter, IRSA, and AWS Secrets Manager. Designed as a getting-started reference for the *Coder + Claude on EKS* blog post.

See `docs/cross-account.md` for the multi-account variant.

## Prerequisites

- AWS account with admin-equivalent credentials
- Domain name + Route 53 hosted zone (this is a hard prerequisite — the ACM wildcard cert and Coder subdomain app routing both depend on it)
- GitHub OAuth app (link to GitHub docs; the only setup-specific bits are: callback URL `https://<your-coder-host>/api/v2/users/oauth2/github/callback`, paste client ID/secret into Secrets Manager entries `coder/github-oauth-client-id` and `coder/github-oauth-client-secret` after deploy)
- Atlassian API token (only if you want Jira MCP in your workspaces)
- Anthropic Claude Code OAuth token (`claude /login`, then read `~/.claude/.credentials.json`)

## Deploy

(Filled in once stacks are wired — see Task 18.)
