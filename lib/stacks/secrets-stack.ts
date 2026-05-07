import * as cdk from 'aws-cdk-lib';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export class SecretsStack extends cdk.Stack {
  public readonly githubClientId: secretsmanager.Secret;
  public readonly githubClientSecret: secretsmanager.Secret;
  public readonly claudeOauthToken: secretsmanager.Secret;
  public readonly jiraApiToken: secretsmanager.Secret;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const placeholder = (name: string, description: string) =>
      new secretsmanager.Secret(this, name.replace(/\//g, '-'), {
        secretName: name,
        description,
        secretStringValue: cdk.SecretValue.unsafePlainText('REPLACE_ME'),
      });

    this.githubClientId = placeholder(
      'demo-coder/github-oauth-client-id',
      'Coder server GitHub OAuth client ID (login + external auth)'
    );
    this.githubClientSecret = placeholder(
      'demo-coder/github-oauth-client-secret',
      'Coder server GitHub OAuth client secret'
    );
    this.claudeOauthToken = placeholder(
      'demo-workspace/claude-oauth-token',
      'Claude Code OAuth token (read by fetch-workspace-secrets.sh)'
    );
    this.jiraApiToken = placeholder(
      'demo-workspace/jira-api-token',
      'Atlassian API token for the Jira MCP'
    );
  }
}
