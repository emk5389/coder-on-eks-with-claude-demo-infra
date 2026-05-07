#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { NetworkingStack } from '../lib/stacks/networking-stack';
import { EksClusterStack } from '../lib/stacks/eks-cluster-stack';
import { SecretsStack } from '../lib/stacks/secrets-stack';
import { CoderServerStack } from '../lib/stacks/coder-server-stack';

const app = new cdk.App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
};

const coderHost = app.node.tryGetContext('coderHost');
const hostedZoneId = app.node.tryGetContext('hostedZoneId');
const hostedZoneName = app.node.tryGetContext('hostedZoneName');
const githubAllowedOrgs = app.node.tryGetContext('githubAllowedOrgs');

if (!coderHost || !hostedZoneId || !hostedZoneName || !githubAllowedOrgs) {
  throw new Error(
    'CoderDemoServer requires coderHost, hostedZoneId, hostedZoneName, and githubAllowedOrgs context values. ' +
    'Pass them via `--context coderHost=... --context hostedZoneId=... --context hostedZoneName=... --context githubAllowedOrgs=...` or add them to cdk.json.'
  );
}

const networking = new NetworkingStack(app, 'CoderDemoNetworking', { env });

const eksCluster = new EksClusterStack(app, 'CoderDemoEks', {
  env,
  vpc: networking.vpc,
});

const secrets = new SecretsStack(app, 'CoderDemoSecrets', { env });

new CoderServerStack(app, 'CoderDemoServer', {
  env,
  vpc: networking.vpc,
  cluster: eksCluster.cluster,
  secrets,
  coderHost,
  hostedZoneId,
  hostedZoneName,
  githubAllowedOrgs,
});
