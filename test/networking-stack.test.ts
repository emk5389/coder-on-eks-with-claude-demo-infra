import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { NetworkingStack } from '../lib/stacks/networking-stack';

describe('NetworkingStack', () => {
  test('creates a VPC with 2 AZs and public + private subnets', () => {
    const app = new cdk.App();
    const stack = new NetworkingStack(app, 'TestNetworking', {
      env: { account: '111111111111', region: 'us-east-1' },
    });
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::EC2::VPC', 1);
    // 2 AZs * (public + private) = 4 subnets
    template.resourceCountIs('AWS::EC2::Subnet', 4);
    // 1 NAT gateway (cost optimization for demo)
    template.resourceCountIs('AWS::EC2::NatGateway', 1);
  });

  test('exposes vpc as a public property', () => {
    const app = new cdk.App();
    const stack = new NetworkingStack(app, 'TestNetworking', {
      env: { account: '111111111111', region: 'us-east-1' },
    });
    expect(stack.vpc).toBeDefined();
  });
});
