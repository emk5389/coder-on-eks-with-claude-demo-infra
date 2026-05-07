# coder-and-claude-on-eks-demo-infra

A publicly shareable AWS CDK package that deploys [Coder](https://coder.com) on EKS with Karpenter scale-to-zero, IRSA, and AWS Secrets Manager. Built as the companion infra for the *Coder + Claude on EKS* blog post.

This package deploys:
- VPC (2 AZs, 1 NAT)
- EKS cluster (`coder-demo`) with a system node group
- Karpenter for workspace node autoscaling (consolidates after 30m idle)
- Coder server (Helm chart) backed by RDS Postgres
- Workspace IAM role (IRSA, `workspace-irsa-role`) with chain-into-app-roles permissions
- Placeholder Secrets Manager entries for the OAuth tokens

What it does **not** include:
- A domain name or hosted zone (you bring your own — see prerequisites)
- An app to run inside workspaces (see [coder-and-claude-on-eks-demo-app](../coder-and-claude-on-eks-demo-app))
- Production hardening (External Secrets Operator, multi-AZ RDS, hardened network policies)

For the multi-account variant, see [`docs/cross-account.md`](docs/cross-account.md).

## Prerequisites

Most of these are link-outs to upstream docs. The blog post walks through them in order.

- **AWS account + admin credentials** locally available (`aws sso login` or `~/.aws/credentials`).
- **A domain name + Route 53 hosted zone** for the Coder server. This is a hard prerequisite — the ACM wildcard cert and Coder's subdomain-based app routing both depend on it. If you don't own a domain yet, register one in Route 53 first.
- **A GitHub OAuth app**. The app's authorization callback URL must be `https://<your-coder-host>/api/v2/users/oauth2/github/callback`. Copy the resulting client ID and client secret into the `coder/github-oauth-client-id` and `coder/github-oauth-client-secret` Secrets Manager entries (created by the SecretsStack on first deploy). The same OAuth app does double duty for both Coder login and per-user GitHub external auth.
- **An Anthropic Claude Code OAuth token** — run `claude /login` once locally, then read it from `~/.claude/.credentials.json`. Paste into `workspace/claude-oauth-token`.
- **(Optional) An Atlassian API token** if you want the Jira MCP working in workspaces. Paste into `workspace/jira-api-token`.

## Deploy

```bash
cd coder-and-claude-on-eks-demo-infra
npm install
npm run build

# Deploy with your domain context
npx cdk deploy --all \
  --context coderHost=coder.example.com \
  --context hostedZoneId=Z123ABC \
  --context hostedZoneName=example.com
```

After the first deploy:

1. Update the placeholder secrets in AWS Secrets Manager (Console or CLI):
   ```bash
   aws secretsmanager put-secret-value --secret-id coder/github-oauth-client-id --secret-string "<your-client-id>"
   aws secretsmanager put-secret-value --secret-id coder/github-oauth-client-secret --secret-string "<your-client-secret>"
   aws secretsmanager put-secret-value --secret-id workspace/claude-oauth-token --secret-string "<your-claude-token>"
   aws secretsmanager put-secret-value --secret-id workspace/jira-api-token --secret-string "<your-jira-token>"
   ```
2. Update the Route 53 records the CDK created (apex + wildcard) to alias the actual NLB hostname:
   ```bash
   kubectl -n coder get svc coder
   # Copy the EXTERNAL-IP (NLB DNS name) and update both Route 53 records to alias it
   ```
3. Re-deploy to refresh the GitHub OAuth k8s secret with the real values:
   ```bash
   npx cdk deploy CoderDemoServer --context coderHost=... --context hostedZoneId=... --context hostedZoneName=...
   ```
4. Visit `https://coder.example.com` and log in via GitHub.

## Push the workspace template

After the cluster is up and you can `coder login`, push the workspace template:

```bash
# Build and push the workspace image to ECR (one-time)
ECR_REPO=$(aws ecr create-repository --repository-name coder-workspace --query 'repository.repositoryUri' --output text 2>/dev/null \
  || aws ecr describe-repositories --repository-names coder-workspace --query 'repositories[0].repositoryUri' --output text)
aws ecr get-login-password | docker login --username AWS --password-stdin "${ECR_REPO%/*}"
docker build -t "$ECR_REPO:latest" docker/workspace
docker push "$ECR_REPO:latest"

# Push the workspace template
cd templates/workspace
coder templates push coder-demo \
  --variable image="$ECR_REPO:latest" \
  --variable workspace_irsa_role_arn="$(aws cloudformation describe-stacks --stack-name CoderDemoWorkspaceIam --query 'Stacks[0].Outputs[?OutputKey==`WorkspaceIrsaRoleArn`].OutputValue' --output text)" \
  --variable coder_deployment_host="coder.example.com"
```

## Tests

```bash
npm test
```

Pure CDK snapshot tests, no AWS calls. Good for CI.
