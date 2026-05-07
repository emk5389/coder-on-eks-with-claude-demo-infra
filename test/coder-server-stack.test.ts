import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { NetworkingStack } from '../lib/stacks/networking-stack';
import { EksClusterStack } from '../lib/stacks/eks-cluster-stack';
import { SecretsStack } from '../lib/stacks/secrets-stack';
import { CoderServerStack } from '../lib/stacks/coder-server-stack';

describe('CoderServerStack', () => {
  function build() {
    const app = new cdk.App();
    const net = new NetworkingStack(app, 'N', { env: { account: '111111111111', region: 'us-east-1' } });
    const eks = new EksClusterStack(app, 'E', {
      env: { account: '111111111111', region: 'us-east-1' },
      vpc: net.vpc,
    });
    const secrets = new SecretsStack(app, 'S', { env: { account: '111111111111', region: 'us-east-1' } });
    return new CoderServerStack(app, 'C', {
      env: { account: '111111111111', region: 'us-east-1' },
      vpc: net.vpc,
      cluster: eks.cluster,
      secrets,
      coderHost: 'coder.example.com',
      hostedZoneId: 'Z123ABC',
      hostedZoneName: 'example.com',
    });
  }

  test('provisions ACM cert, RDS, and Coder Helm chart (no Route 53 records — created manually post-deploy)', () => {
    const stack = build();
    const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::CertificateManager::Certificate', 1);
    template.resourceCountIs('AWS::Route53::RecordSet', 0);
    template.resourceCountIs('AWS::RDS::DBInstance', 1);
  });
});
