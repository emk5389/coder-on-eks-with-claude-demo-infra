import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as eks from 'aws-cdk-lib/aws-eks';
import * as iam from 'aws-cdk-lib/aws-iam';
import { KubectlV30Layer } from '@aws-cdk/lambda-layer-kubectl-v30';
import { Construct } from 'constructs';
import { KarpenterNodePool } from '../constructs/karpenter-node-pool';

export interface EksClusterStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
}

export class EksClusterStack extends cdk.Stack {
  public readonly cluster: eks.Cluster;

  constructor(scope: Construct, id: string, props: EksClusterStackProps) {
    super(scope, id, props);

    // Admin role — any IAM principal in the account can assume this
    // to get kubectl access to the cluster.
    const adminRole = new iam.Role(this, 'ClusterAdmin', {
      assumedBy: new iam.AccountRootPrincipal(),
      roleName: 'coder-demo-cluster-admin',
    });

    this.cluster = new eks.Cluster(this, 'Cluster', {
      version: eks.KubernetesVersion.V1_30,
      vpc: props.vpc,
      defaultCapacity: 0,
      kubectlLayer: new KubectlV30Layer(this, 'KubectlLayer'),
      clusterName: 'coder-demo',
      endpointAccess: eks.EndpointAccess.PUBLIC_AND_PRIVATE,
      mastersRole: adminRole,
      authenticationMode: eks.AuthenticationMode.API_AND_CONFIG_MAP,
    });

    this.cluster.addNodegroupCapacity('SystemNodes', {
      instanceTypes: [new ec2.InstanceType('t3.medium')],
      minSize: 2,
      maxSize: 3,
      desiredSize: 2,
      taints: [
        { key: 'CriticalAddonsOnly', value: 'true', effect: eks.TaintEffect.NO_SCHEDULE },
      ],
      labels: { role: 'system' },
    });

    // ---------------------------------------------------------------
    // AWS Load Balancer Controller — provisions NLBs for LoadBalancer Services
    // ---------------------------------------------------------------
    const lbcSa = new eks.ServiceAccount(this, 'LbcServiceAccount', {
      cluster: this.cluster,
      name: 'aws-load-balancer-controller',
      namespace: 'kube-system',
    });
    lbcSa.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: [
        'ec2:*',
        'elasticloadbalancing:*',
        'acm:DescribeCertificate',
        'acm:ListCertificates',
        'iam:CreateServiceLinkedRole',
        'wafv2:*',
        'shield:*',
        'tag:GetResources',
        'tag:TagResources',
      ],
      resources: ['*'],
    }));

    new eks.HelmChart(this, 'AwsLoadBalancerController', {
      cluster: this.cluster,
      chart: 'aws-load-balancer-controller',
      release: 'aws-load-balancer-controller',
      repository: 'https://aws.github.io/eks-charts',
      namespace: 'kube-system',
      version: '1.11.0',
      values: {
        clusterName: this.cluster.clusterName,
        serviceAccount: { create: false, name: 'aws-load-balancer-controller' },
        region: cdk.Stack.of(this).region,
        vpcId: props.vpc.vpcId,
        enableServiceMutatorWebhook: false,
        tolerations: [
          { key: 'CriticalAddonsOnly', operator: 'Exists', effect: 'NoSchedule' },
        ],
        nodeSelector: { role: 'system' },
      },
    });

    // ---------------------------------------------------------------
    // EBS CSI Driver (required for gp3 PVCs)
    // ---------------------------------------------------------------
    const ebsCsiCondition = new cdk.CfnJson(this, 'EbsCsiOidcCondition', {
      value: {
        [`${this.cluster.clusterOpenIdConnectIssuer}:aud`]: 'sts.amazonaws.com',
        [`${this.cluster.clusterOpenIdConnectIssuer}:sub`]: 'system:serviceaccount:kube-system:ebs-csi-controller-sa',
      },
    });

    const ebsCsiRole = new iam.Role(this, 'EbsCsiDriverRole', {
      assumedBy: new iam.FederatedPrincipal(
        this.cluster.openIdConnectProvider.openIdConnectProviderArn,
        { StringEquals: ebsCsiCondition },
        'sts:AssumeRoleWithWebIdentity',
      ),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonEBSCSIDriverPolicy'),
      ],
    });

    new eks.CfnAddon(this, 'EbsCsiAddon', {
      addonName: 'aws-ebs-csi-driver',
      clusterName: this.cluster.clusterName,
      serviceAccountRoleArn: ebsCsiRole.roleArn,
      resolveConflicts: 'OVERWRITE',
    });

    this.cluster.addManifest('Gp3StorageClass', {
      apiVersion: 'storage.k8s.io/v1',
      kind: 'StorageClass',
      metadata: { name: 'gp3' },
      provisioner: 'ebs.csi.aws.com',
      parameters: { type: 'gp3' },
      volumeBindingMode: 'WaitForFirstConsumer',
      allowVolumeExpansion: true,
    });

    // ---------------------------------------------------------------
    // Workspace IRSA Role
    // ---------------------------------------------------------------
    const workspaceOidcCondition = new cdk.CfnJson(this, 'WorkspaceOidcCondition', {
      value: {
        [`${this.cluster.clusterOpenIdConnectIssuer}:aud`]: 'sts.amazonaws.com',
        [`${this.cluster.clusterOpenIdConnectIssuer}:sub`]: 'system:serviceaccount:coder:workspace-*',
      },
    });

    const workspaceIrsaRole = new iam.Role(this, 'WorkspaceIrsaRole', {
      roleName: 'workspace-irsa-role',
      assumedBy: new iam.FederatedPrincipal(
        this.cluster.openIdConnectProvider.openIdConnectProviderArn,
        { StringLike: workspaceOidcCondition },
        'sts:AssumeRoleWithWebIdentity',
      ),
      description: 'IRSA role assumed by Coder workspace pods. Chains into per-app access roles.',
    });

    workspaceIrsaRole.addToPolicy(new iam.PolicyStatement({
      actions: ['sts:AssumeRole', 'sts:TagSession'],
      resources: [`arn:aws:iam::*:role/demo-doc-chat-*-access-role`],
    }));

    workspaceIrsaRole.addToPolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [`arn:aws:secretsmanager:${this.region}:${this.account}:secret:demo-workspace/*`],
    }));

    // ---------------------------------------------------------------
    // Karpenter (workspace node autoscaling)
    // ---------------------------------------------------------------
    const karpenterNodeRole = new iam.Role(this, 'KarpenterNodeRole', {
      roleName: `KarpenterNodeRole-${this.cluster.clusterName}`,
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEKSWorkerNodePolicy'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEKS_CNI_Policy'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEC2ContainerRegistryReadOnly'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });

    new cdk.CfnResource(this, 'KarpenterNodeAccess', {
      type: 'AWS::EKS::AccessEntry',
      properties: {
        ClusterName: this.cluster.clusterName,
        PrincipalArn: karpenterNodeRole.roleArn,
        Type: 'EC2_LINUX',
      },
    });

    const karpenterSa = new eks.ServiceAccount(this, 'KarpenterSa', {
      cluster: this.cluster,
      name: 'karpenter',
      namespace: 'kube-system',
    });
    karpenterSa.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: [
        'ec2:*',
        'iam:PassRole',
        'iam:CreateInstanceProfile',
        'iam:TagInstanceProfile',
        'iam:AddRoleToInstanceProfile',
        'iam:RemoveRoleFromInstanceProfile',
        'iam:DeleteInstanceProfile',
        'iam:GetInstanceProfile',
        'iam:ListInstanceProfiles',
        'pricing:GetProducts',
        'ssm:GetParameter',
        'eks:DescribeCluster',
      ],
      resources: ['*'],
    }));

    const karpenterChart = new eks.HelmChart(this, 'Karpenter', {
      cluster: this.cluster,
      chart: 'karpenter',
      release: 'karpenter',
      repository: 'oci://public.ecr.aws/karpenter/karpenter',
      version: '1.0.6',
      namespace: 'kube-system',
      values: {
        settings: { clusterName: this.cluster.clusterName },
        serviceAccount: { create: false, name: 'karpenter' },
      },
    });

    // NodePool + EC2NodeClass — must wait for Helm chart to install CRDs
    const karpenterNodePool = new KarpenterNodePool(this, 'WorkspacePool', {
      cluster: this.cluster,
      nodeRoleName: karpenterNodeRole.roleName,
      clusterName: 'coder-demo',
    });
    karpenterNodePool.node.addDependency(karpenterChart);

    // Tag subnets and cluster SG for Karpenter discovery
    for (const subnet of props.vpc.privateSubnets) {
      cdk.Tags.of(subnet).add('karpenter.sh/discovery', 'coder-demo');
    }
    cdk.Tags.of(this.cluster.clusterSecurityGroup).add('karpenter.sh/discovery', 'coder-demo');

    // ---------------------------------------------------------------
    // Outputs
    // ---------------------------------------------------------------
    new cdk.CfnOutput(this, 'ClusterName', { value: this.cluster.clusterName });
    new cdk.CfnOutput(this, 'ClusterAdminRoleArn', { value: adminRole.roleArn });
    new cdk.CfnOutput(this, 'OidcIssuer', { value: this.cluster.clusterOpenIdConnectIssuerUrl });
    new cdk.CfnOutput(this, 'WorkspaceIrsaRoleArn', { value: workspaceIrsaRole.roleArn });
  }
}
