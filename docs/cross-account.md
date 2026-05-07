# Cross-Account Variant

The main demo runs in a single AWS account but shapes the IAM as if it were two — the Coder workspace IRSA role assumes a separate access role even though both live in one account. This appendix shows the diff to make it *actually* cross-account.

## Why bother

- **Blast radius.** Per-developer dev resources live in personal accounts. A blow-up in one account doesn't take down others.
- **Personal billing.** Each developer pays for their own dev S3, KMS, etc.
- **Centralized platform, distributed apps.** The platform team owns the management account (Coder cluster, IRSA role, secrets). Application teams own dev resources in their own accounts and grant cross-account access to the management account's IRSA role.

This is the pattern Inquisita uses in production.

## The diff

There are exactly three changes from the single-account version.

### 1. WorkspaceIamStack — keep the glob, it already matches across accounts

The `sts:AssumeRole` resource glob `arn:aws:iam::*:role/doc-chat-*-access-role` already permits assuming roles in any account. **No change needed** to the infra CDK as long as you trust the calling pattern.

If you want to scope it tighter:

```diff
 actions: ['sts:AssumeRole', 'sts:TagSession'],
-resources: [`arn:aws:iam::*:role/doc-chat-*-access-role`],
+resources: [
+  `arn:aws:iam::${DEV_ACCOUNT_A}:role/doc-chat-*-access-role`,
+  `arn:aws:iam::${DEV_ACCOUNT_B}:role/doc-chat-*-access-role`,
+],
```

### 2. DocChatAccessRole trust policy — point at the management account

In `coder-and-claude-on-eks-demo-app/packages/cdk/lib/stacks/dev-resources-stack.ts`:

```diff
 const accessRole = new iam.Role(this, 'DocChatAccessRole', {
   roleName: 'doc-chat-dev-access-role',
-  assumedBy: new iam.ArnPrincipal(workspaceIrsaRoleArn),
+  assumedBy: new iam.ArnPrincipal(
+    `arn:aws:iam::${MANAGEMENT_ACCOUNT_ID}:role/workspace-irsa-role`
+  ),
   description: 'Role assumed by Coder workspace IRSA to access doc-chat dev resources',
 });
```

### 3. Deploy steps

1. Switch credentials to the management account.
2. `cdk deploy` the infra package there. Note the `WorkspaceIrsaRoleArn` output.
3. Switch credentials to the developer's personal account.
4. `cdk deploy` the demo-app dev CDK there, passing the management account's role ARN.

## What changes operationally

- Secrets `coder/*` live in the management account.
- Secrets `workspace/*` live in the management account (so `fetch-workspace-secrets.sh` can read them via the IRSA role).
- App-specific dev secrets (if any) live in the developer's personal account and are read via the access role chain.
- Billing for the cluster, RDS, NLB, ACM lives in the management account.
- Billing for documents bucket, KMS, Bedrock invocations lives in the developer's personal account.

That's the entire diff.
