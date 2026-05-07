import * as eks from 'aws-cdk-lib/aws-eks';
import { Construct } from 'constructs';

export interface KarpenterNodePoolProps {
  cluster: eks.ICluster;
  nodeRoleName: string;
  clusterName: string;
}

export class KarpenterNodePool extends Construct {
  constructor(scope: Construct, id: string, props: KarpenterNodePoolProps) {
    super(scope, id);

    const ec2NodeClass = {
      apiVersion: 'karpenter.k8s.aws/v1',
      kind: 'EC2NodeClass',
      metadata: { name: 'workspace' },
      spec: {
        amiFamily: 'AL2023',
        amiSelectorTerms: [{ alias: 'al2023@latest' }],
        role: props.nodeRoleName,
        subnetSelectorTerms: [
          { tags: { 'karpenter.sh/discovery': props.clusterName } },
        ],
        securityGroupSelectorTerms: [
          { tags: { 'karpenter.sh/discovery': props.clusterName } },
        ],
        blockDeviceMappings: [
          {
            deviceName: '/dev/xvda',
            ebs: { volumeSize: '100Gi', volumeType: 'gp3', encrypted: true, deleteOnTermination: true },
          },
        ],
      },
    };

    const nodePool = {
      apiVersion: 'karpenter.sh/v1',
      kind: 'NodePool',
      metadata: { name: 'workspace' },
      spec: {
        template: {
          metadata: { labels: { role: 'workspace' } },
          spec: {
            nodeClassRef: { group: 'karpenter.k8s.aws', kind: 'EC2NodeClass', name: 'workspace' },
            requirements: [
              { key: 'karpenter.k8s.aws/instance-family', operator: 'In', values: ['m7i'] },
              { key: 'karpenter.k8s.aws/instance-size', operator: 'In', values: ['xlarge'] },
              { key: 'karpenter.sh/capacity-type', operator: 'In', values: ['on-demand'] },
            ],
            expireAfter: '720h',
          },
        },
        disruption: {
          consolidationPolicy: 'WhenEmpty',
          consolidateAfter: '30m',
        },
        limits: { cpu: '100' },
      },
    };

    // Create KubernetesManifest directly in this construct's scope to avoid
    // cross-stack dependency cycles that cluster.addManifest() would cause.
    new eks.KubernetesManifest(this, 'KarpenterEc2NodeClass', {
      cluster: props.cluster,
      manifest: [ec2NodeClass],
    });

    new eks.KubernetesManifest(this, 'KarpenterNodePool', {
      cluster: props.cluster,
      manifest: [nodePool],
    });
  }
}
