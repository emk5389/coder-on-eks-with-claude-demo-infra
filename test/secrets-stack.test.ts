import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { SecretsStack } from '../lib/stacks/secrets-stack';

describe('SecretsStack', () => {
  test('creates four placeholder secrets', () => {
    const app = new cdk.App();
    const stack = new SecretsStack(app, 'TestSecrets', {
      env: { account: '111111111111', region: 'us-east-1' },
    });
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::SecretsManager::Secret', 4);
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'demo-coder/github-oauth-client-id',
    });
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'demo-coder/github-oauth-client-secret',
    });
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'demo-workspace/claude-oauth-token',
    });
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'demo-workspace/jira-api-token',
    });
  });
});
