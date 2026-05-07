#!/bin/sh
# Fetch workspace secrets from AWS Secrets Manager and set up the AWS profile chain.
# Runs *before* the Coder agent so env vars are available to all subsequent shell sessions
# via BASH_ENV=/home/coder/.workspace-secrets.

SECRETS_FILE="/home/coder/.workspace-secrets"
: > "$SECRETS_FILE"

# Force terminal color support — agentapi spawns shells with TERM=vt100
echo "export TERM=xterm-256color" >> "$SECRETS_FILE"

if [ -z "$WORKSPACE_ACCESS_ROLE_ARN" ]; then
  echo "[fetch-secrets] WORKSPACE_ACCESS_ROLE_ARN not set; skipping AWS chain setup."
else
  echo "[fetch-secrets] Configuring AWS role chain: $WORKSPACE_ACCESS_ROLE_ARN"
  mkdir -p /home/coder/.aws
  cat > /home/coder/.aws/config << EOF
[profile irsa]
role_arn = $AWS_ROLE_ARN
web_identity_token_file = $AWS_WEB_IDENTITY_TOKEN_FILE
region = $AWS_REGION

[default]
role_arn = $WORKSPACE_ACCESS_ROLE_ARN
source_profile = irsa
region = $AWS_REGION
EOF
fi

# Pull secrets (workspace-scoped, single account)
for pair in \
  "demo-workspace/claude-oauth-token:CLAUDE_CODE_OAUTH_TOKEN" \
  "demo-workspace/jira-api-token:JIRA_API_TOKEN"; do
  secret_id="${pair%%:*}"
  env_var="${pair##*:}"
  val=$(aws secretsmanager get-secret-value --secret-id "$secret_id" --query SecretString --output text 2>/dev/null) || true
  if [ -n "$val" ] && [ "$val" != "REPLACE_ME" ]; then
    echo "export ${env_var}='${val}'" >> "$SECRETS_FILE"
    export "${env_var}=${val}"
    echo "[fetch-secrets] Set $env_var"
  else
    echo "[fetch-secrets] WARNING: Could not fetch $secret_id (placeholder secret may be empty or REPLACE_ME)"
  fi
done

# Workaround: the Coder Claude Code module unconditionally sets CLAUDE_CODE_OAUTH_TOKEN="".
# Write the token directly to the credentials file so Claude Code reads it from disk.
if [ -n "$CLAUDE_CODE_OAUTH_TOKEN" ]; then
  mkdir -p /home/coder/.claude
  cat > /home/coder/.claude/.credentials.json << CREDS
{"claudeAiOauth":{"accessToken":"${CLAUDE_CODE_OAUTH_TOKEN}","refreshToken":"","expiresAt":9999999999999,"scopes":["user:inference","user:profile","user:sessions:claude_code"]}}
CREDS
  chmod 600 /home/coder/.claude/.credentials.json
  echo "[fetch-secrets] Wrote Claude Code credentials file"
fi

echo "[fetch-secrets] Done."
