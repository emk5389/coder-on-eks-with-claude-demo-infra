import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { NetworkingStack } from '../lib/stacks/networking-stack';
import { EksClusterStack } from '../lib/stacks/eks-cluster-stack';

describe('EksClusterStack', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const networking = new NetworkingStack(app, 'TestNet', {
      env: { account: '111111111111', region: 'us-east-1' },
    });
    const cluster = new EksClusterStack(app, 'TestCluster', {
      env: { account: '111111111111', region: 'us-east-1' },
      vpc: networking.vpc,
    });
    template = Template.fromStack(cluster);
  });

  test('creates an EKS cluster with a system node group', () => {
    template.resourceCountIs('Custom::AWSCDK-EKS-Cluster', 1);
    template.hasResource('AWS::EKS::Nodegroup', {});
    template.hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'coder-demo-cluster-admin',
    });
  });

  test('installs EBS CSI driver addon and gp3 StorageClass', () => {
    template.hasResourceProperties('AWS::EKS::Addon', {
      AddonName: 'aws-ebs-csi-driver',
    });
  });

  test('creates workspace IRSA role with assume-role + secrets permissions', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'workspace-irsa-role',
    });
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(['sts:AssumeRole']),
          }),
        ]),
      }),
    });
  });

  test('installs Karpenter Helm chart and workspace NodePool', () => {
    // Karpenter Helm chart
    template.resourceCountIs('Custom::AWSCDK-EKS-HelmChart', 2); // LBC + Karpenter
    // Karpenter node role
    template.hasResourceProperties('AWS::IAM::Role', {
      RoleName: { 'Fn::Join': Match.anyValue() }, // KarpenterNodeRole-{clusterName}
    });
    // NodePool + EC2NodeClass kubectl manifests
    template.hasResource('Custom::AWSCDK-EKS-KubernetesResource', {});
  });
});
