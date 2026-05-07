import * as cdk from 'aws-cdk-lib';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as eks from 'aws-cdk-lib/aws-eks';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import { Construct } from 'constructs';
import { SecretsStack } from './secrets-stack';

export interface CoderServerStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
  cluster: eks.Cluster;
  secrets: SecretsStack;
  coderHost: string;       // e.g. coder.example.com
  hostedZoneId: string;    // Route 53 hosted zone ID
  hostedZoneName: string;  // e.g. coder.example.com
  githubAllowedOrgs: string;  // GitHub org(s) allowed to sign into Coder (comma-separated)
}

export class CoderServerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: CoderServerStackProps) {
    super(scope, id, props);

    // ---------------------------------------------------------------
    // 1. RDS Postgres
    // ---------------------------------------------------------------
    const dbSg = new ec2.SecurityGroup(this, 'DbSg', {
      vpc: props.vpc,
      description: 'Coder RDS security group',
      allowAllOutbound: true,
    });
    dbSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(5432), 'Allow Postgres');

    const dbCreds = rds.Credentials.fromGeneratedSecret('coderadmin');

    const db = new rds.DatabaseInstance(this, 'CoderDb', {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_16,
      }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [dbSg],
      databaseName: 'coder',
      credentials: dbCreds,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      deletionProtection: false,
      backupRetention: cdk.Duration.days(7),
      allocatedStorage: 20,
    });

    // ---------------------------------------------------------------
    // 2. ACM Certificate
    // ---------------------------------------------------------------
    const hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', {
      hostedZoneId: props.hostedZoneId,
      zoneName: props.hostedZoneName,
    });

    const cert = new acm.Certificate(this, 'CoderCert', {
      domainName: props.coderHost,
      subjectAlternativeNames: [`*.${props.coderHost}`],
      validation: acm.CertificateValidation.fromDns(hostedZone),
    });

    // Route 53 records are created manually after deploy — the NLB hostname
    // is only known once the Kubernetes Service is provisioned.  See the
    // NextStepsHint output at the bottom of this stack.

    // ---------------------------------------------------------------
    // 3. Coder namespace
    // ---------------------------------------------------------------
    const coderNamespace = new eks.KubernetesManifest(this, 'CoderNamespace', {
      cluster: props.cluster,
      manifest: [{
        apiVersion: 'v1',
        kind: 'Namespace',
        metadata: { name: 'coder' },
      }],
    });

    // ---------------------------------------------------------------
    // 4. Coder DB secret (Kubernetes)
    // ---------------------------------------------------------------
    // CloudFormation does not resolve dynamic references ({{resolve:...}})
    // in custom resource properties. Since KubernetesManifest uses a custom
    // resource, we resolve the RDS secret via a Lambda instead.
    const secretResolver = new lambda.Function(this, 'SecretResolver', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
exports.handler = async (event) => {
  if (event.RequestType === 'Delete') return { Data: {} };
  const client = new SecretsManagerClient({});
  const resp = await client.send(new GetSecretValueCommand({
    SecretId: event.ResourceProperties.SecretArn,
  }));
  const creds = JSON.parse(resp.SecretString);
  const data = {};
  for (const key of Object.keys(creds)) data[key] = creds[key];
  return { Data: data };
};
`),
    });

    const secretResolverProvider = new cr.Provider(this, 'SecretResolverProvider', {
      onEventHandler: secretResolver,
    });

    const dbSecret = db.secret!;
    dbSecret.grantRead(secretResolver);

    const dbCredsResource = new cdk.CustomResource(this, 'DbCreds', {
      serviceToken: secretResolverProvider.serviceToken,
      properties: { SecretArn: dbSecret.secretArn },
    });

    const connectionUrl = cdk.Fn.join('', [
      'postgres://',
      dbCredsResource.getAttString('username'),
      ':',
      dbCredsResource.getAttString('password'),
      '@',
      db.dbInstanceEndpointAddress,
      ':5432/coder?sslmode=require',
    ]);

    const coderDbSecret = new eks.KubernetesManifest(this, 'CoderDbSecret', {
      cluster: props.cluster,
      manifest: [{
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: {
          name: 'coder-db',
          namespace: 'coder',
        },
        stringData: {
          url: connectionUrl,
        },
      }],
    });
    coderDbSecret.node.addDependency(coderNamespace);
    coderDbSecret.node.addDependency(dbCredsResource);

    // ---------------------------------------------------------------
    // 5. GitHub OAuth secret (Kubernetes)
    // ---------------------------------------------------------------
    // GitHub OAuth secrets are plain strings (not JSON), so we use
    // AwsCustomResource to read them — same dynamic-reference issue.
    const ghClientId = new cr.AwsCustomResource(this, 'GhClientIdLookup', {
      onCreate: {
        service: 'SecretsManager',
        action: 'getSecretValue',
        parameters: { SecretId: props.secrets.githubClientId.secretArn },
        physicalResourceId: cr.PhysicalResourceId.of('gh-client-id'),
      },
      onUpdate: {
        service: 'SecretsManager',
        action: 'getSecretValue',
        parameters: { SecretId: props.secrets.githubClientId.secretArn },
        physicalResourceId: cr.PhysicalResourceId.of('gh-client-id'),
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({ resources: [props.secrets.githubClientId.secretArn] }),
    });
    const ghClientSecret = new cr.AwsCustomResource(this, 'GhClientSecretLookup', {
      onCreate: {
        service: 'SecretsManager',
        action: 'getSecretValue',
        parameters: { SecretId: props.secrets.githubClientSecret.secretArn },
        physicalResourceId: cr.PhysicalResourceId.of('gh-client-secret'),
      },
      onUpdate: {
        service: 'SecretsManager',
        action: 'getSecretValue',
        parameters: { SecretId: props.secrets.githubClientSecret.secretArn },
        physicalResourceId: cr.PhysicalResourceId.of('gh-client-secret'),
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({ resources: [props.secrets.githubClientSecret.secretArn] }),
    });

    const githubOauthSecret = new eks.KubernetesManifest(this, 'GithubOauthSecret', {
      cluster: props.cluster,
      manifest: [{
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: {
          name: 'coder-github-oauth',
          namespace: 'coder',
        },
        stringData: {
          'client-id': ghClientId.getResponseField('SecretString'),
          'client-secret': ghClientSecret.getResponseField('SecretString'),
        },
      }],
    });
    githubOauthSecret.node.addDependency(coderNamespace);

    // ---------------------------------------------------------------
    // 6. Coder Helm chart
    // ---------------------------------------------------------------
    const coderHelm = new eks.HelmChart(this, 'CoderHelm', {
      cluster: props.cluster,
      chart: 'coder',
      release: 'coder',
      repository: 'https://helm.coder.com/v2',
      namespace: 'coder',
      version: '2.30.2',
      values: {
        coder: {
          env: [
            {
              name: 'CODER_PG_CONNECTION_URL',
              valueFrom: {
                secretKeyRef: {
                  name: 'coder-db',
                  key: 'url',
                },
              },
            },
            {
              name: 'CODER_ACCESS_URL',
              value: `https://${props.coderHost}`,
            },
            {
              name: 'CODER_WILDCARD_ACCESS_URL',
              value: `*.${props.coderHost}`,
            },
            {
              name: 'CODER_OAUTH2_GITHUB_CLIENT_ID',
              valueFrom: {
                secretKeyRef: {
                  name: 'coder-github-oauth',
                  key: 'client-id',
                },
              },
            },
            {
              name: 'CODER_OAUTH2_GITHUB_CLIENT_SECRET',
              valueFrom: {
                secretKeyRef: {
                  name: 'coder-github-oauth',
                  key: 'client-secret',
                },
              },
            },
            {
              name: 'CODER_OAUTH2_GITHUB_ALLOW_SIGNUPS',
              value: 'true',
            },
            {
              name: 'CODER_OAUTH2_GITHUB_ALLOWED_ORGS',
              value: props.githubAllowedOrgs,
            },
            {
              name: 'CODER_EXTERNAL_AUTH_0_TYPE',
              value: 'github',
            },
            {
              name: 'CODER_EXTERNAL_AUTH_0_CLIENT_ID',
              valueFrom: {
                secretKeyRef: {
                  name: 'coder-github-oauth',
                  key: 'client-id',
                },
              },
            },
            {
              name: 'CODER_EXTERNAL_AUTH_0_CLIENT_SECRET',
              valueFrom: {
                secretKeyRef: {
                  name: 'coder-github-oauth',
                  key: 'client-secret',
                },
              },
            },
          ],
          // Disable built-in service — we create a custom Service below
          // with port 443 for NLB TLS termination.
          service: { enable: false },
          tolerations: [
            { key: 'CriticalAddonsOnly', operator: 'Equal', value: 'true', effect: 'NoSchedule' },
          ],
          nodeSelector: { role: 'system' },
          resources: {
            requests: { cpu: '500m', memory: '1Gi' },
            limits: { cpu: '1500m', memory: '2Gi' },
          },
        },
      },
    });
    coderHelm.node.addDependency(coderNamespace);
    coderHelm.node.addDependency(githubOauthSecret);

    // ---------------------------------------------------------------
    // 7. RBAC: allow Coder SA to manage workspace ServiceAccounts
    // ---------------------------------------------------------------
    const saManagerRole = new eks.KubernetesManifest(this, 'CoderSaManagerRole', {
      cluster: props.cluster,
      manifest: [{
        apiVersion: 'rbac.authorization.k8s.io/v1',
        kind: 'Role',
        metadata: {
          name: 'coder-sa-manager',
          namespace: 'coder',
        },
        rules: [
          {
            apiGroups: [''],
            resources: ['serviceaccounts'],
            verbs: ['create', 'get', 'list', 'watch', 'update', 'patch', 'delete'],
          },
        ],
      }],
    });
    saManagerRole.node.addDependency(coderNamespace);

    const saManagerBinding = new eks.KubernetesManifest(this, 'CoderSaManagerRoleBinding', {
      cluster: props.cluster,
      manifest: [{
        apiVersion: 'rbac.authorization.k8s.io/v1',
        kind: 'RoleBinding',
        metadata: {
          name: 'coder-sa-manager',
          namespace: 'coder',
        },
        subjects: [
          {
            kind: 'ServiceAccount',
            name: 'coder',
            namespace: 'coder',
          },
        ],
        roleRef: {
          kind: 'Role',
          name: 'coder-sa-manager',
          apiGroup: 'rbac.authorization.k8s.io',
        },
      }],
    });
    saManagerBinding.node.addDependency(saManagerRole);

    // ---------------------------------------------------------------
    // 8. Custom Service with TLS (NLB terminates TLS via in-tree provider)
    // ---------------------------------------------------------------
    const coderService = new eks.KubernetesManifest(this, 'CoderService', {
      cluster: props.cluster,
      manifest: [{
        apiVersion: 'v1',
        kind: 'Service',
        metadata: {
          name: 'coder',
          namespace: 'coder',
          annotations: {
            'service.beta.kubernetes.io/aws-load-balancer-type': 'nlb',
            'service.beta.kubernetes.io/aws-load-balancer-scheme': 'internet-facing',
            'service.beta.kubernetes.io/aws-load-balancer-ssl-cert': cert.certificateArn,
            'service.beta.kubernetes.io/aws-load-balancer-ssl-ports': '443',
            'service.beta.kubernetes.io/aws-load-balancer-ssl-negotiation-policy': 'ELBSecurityPolicy-TLS13-1-2-2021-06',
            'service.beta.kubernetes.io/aws-load-balancer-backend-protocol': 'tcp',
          },
        },
        spec: {
          type: 'LoadBalancer',
          sessionAffinity: 'None',
          externalTrafficPolicy: 'Local',
          selector: { 'app.kubernetes.io/name': 'coder' },
          ports: [
            { name: 'https', port: 443, targetPort: 'http', protocol: 'TCP' },
          ],
        },
      }],
    });
    coderService.node.addDependency(coderHelm);

    // ---------------------------------------------------------------
    // 8. CfnOutputs
    // ---------------------------------------------------------------
    new cdk.CfnOutput(this, 'CoderAccessUrl', {
      value: `https://${props.coderHost}`,
    });
    new cdk.CfnOutput(this, 'CoderDbEndpoint', {
      value: db.dbInstanceEndpointAddress,
    });
    new cdk.CfnOutput(this, 'NextStepsHint', {
      value: 'Run: kubectl -n coder get svc coder — then create Route 53 A-alias (apex) and CNAME (*) records pointing at the NLB hostname.',
    });
  }
}
