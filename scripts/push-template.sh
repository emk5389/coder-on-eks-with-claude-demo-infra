#!/bin/bash
set -euo pipefail

# Push Coder workspace and task templates with standard configuration.
# Reads workspace role ARN from CDK stack outputs.
#
# Usage:
#   ./scripts/push-template.sh              # push templates only
#   ./scripts/push-template.sh --build      # rebuild and push Docker image first
#
# Prerequisites:
#   - CODER_URL and CODER_SESSION_TOKEN must be set (run `coder login` first)
#   - AWS credentials configured (--profile dev or equivalent)
#   - Docker running locally (if using --build)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

WORKSPACE_TEMPLATE_NAME="coder-demo"
WORKSPACE_TEMPLATE_DIR="$PROJECT_ROOT/templates/workspace"
TASK_TEMPLATE_NAME="ui-change-task"
TASK_TEMPLATE_DIR="$PROJECT_ROOT/templates/task"
STACK_NAME="CoderDemoEks"
ECR_REPO_NAME="coder-demo-workspace"
AWS_PROFILE="${AWS_PROFILE:-dev}"
AWS_REGION="${AWS_REGION:-us-east-1}"
CODER_HOST="${CODER_HOST:-}"
JIRA_URL="${JIRA_URL:-}"
REPO_URL="${REPO_URL:-https://github.com/emk5389/coder-on-eks-with-claude-demo-app.git}"

if [ -z "$CODER_HOST" ]; then
  echo "Error: CODER_HOST must be set (e.g. demo.coder.example.com)"
  exit 1
fi

# --- Parse args ---
BUILD_IMAGE=false
for arg in "$@"; do
  case "$arg" in
    --build) BUILD_IMAGE=true ;;
    *) echo "Unknown arg: $arg"; exit 1 ;;
  esac
done

# --- Ensure Coder access ---
if [ -z "${CODER_URL:-}" ] || [ -z "${CODER_SESSION_TOKEN:-}" ]; then
  echo "Error: CODER_URL and CODER_SESSION_TOKEN must be set"
  echo ""
  echo "  export CODER_URL=https://$CODER_HOST"
  echo "  export CODER_SESSION_TOKEN=\$(coder tokens create)"
  echo ""
  echo "Or run: coder login https://$CODER_HOST"
  exit 1
fi

# --- Read CDK outputs ---
echo "Reading CDK stack outputs..."
WORKSPACE_ROLE_ARN=$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --query 'Stacks[0].Outputs[?OutputKey==`WorkspaceIrsaRoleArn`].OutputValue' \
  --output text \
  --profile "$AWS_PROFILE" \
  --region "$AWS_REGION")

# --- Read demo-app CDK outputs (DocChatDevResources stack) ---
# These are deployed separately from the demo-app repo. If the stack doesn't
# exist yet, the values stay empty and the workspace template still synths.
ACCESS_ROLE_ARN=$(aws cloudformation describe-stacks \
  --stack-name "DocChatDevResources" \
  --query 'Stacks[0].Outputs[?OutputKey==`AccessRoleArn`].OutputValue' \
  --output text \
  --profile "$AWS_PROFILE" \
  --region "$AWS_REGION" 2>/dev/null || echo "")

DOCUMENTS_BUCKET=$(aws cloudformation describe-stacks \
  --stack-name "DocChatDevResources" \
  --query 'Stacks[0].Outputs[?OutputKey==`DocumentsBucketName`].OutputValue' \
  --output text \
  --profile "$AWS_PROFILE" \
  --region "$AWS_REGION" 2>/dev/null || echo "")

# --- Ensure ECR repo exists ---
IMAGE_REPO=$(aws ecr describe-repositories \
  --repository-names "$ECR_REPO_NAME" \
  --query 'repositories[0].repositoryUri' \
  --output text \
  --profile "$AWS_PROFILE" \
  --region "$AWS_REGION" 2>/dev/null) || \
IMAGE_REPO=$(aws ecr create-repository \
  --repository-name "$ECR_REPO_NAME" \
  --query 'repository.repositoryUri' \
  --output text \
  --profile "$AWS_PROFILE" \
  --region "$AWS_REGION")

IMAGE="${IMAGE_REPO}:latest"

echo "  Workspace:   $WORKSPACE_TEMPLATE_NAME"
echo "  Task:        $TASK_TEMPLATE_NAME"
echo "  Image:       $IMAGE"
echo "  Role ARN:    $WORKSPACE_ROLE_ARN"
echo "  Coder Host:  $CODER_HOST"

# --- Build and push image (optional) ---
if [ "$BUILD_IMAGE" = true ]; then
  echo ""
  echo "Building workspace image..."
  ACCOUNT_ID=$(echo "$IMAGE_REPO" | cut -d. -f1)
  REGION=$(echo "$IMAGE_REPO" | cut -d. -f4)

  aws ecr get-login-password --region "$REGION" --profile "$AWS_PROFILE" \
    | docker login --username AWS --password-stdin "${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"

  docker build -t "$IMAGE" "$PROJECT_ROOT/docker/workspace/"
  docker push "$IMAGE"
  echo "Image pushed."
fi

# --- Common template variables ---
COMMON_VARS=(
  --variable "namespace=coder"
  --variable "image=$IMAGE"
  --variable "workspace_irsa_role_arn=$WORKSPACE_ROLE_ARN"
  --variable "repo_url=$REPO_URL"
  --variable "coder_deployment_host=$CODER_HOST"
  --variable "documents_bucket=$DOCUMENTS_BUCKET"
  --variable "jira_url=$JIRA_URL"
)

# --- Push workspace template ---
echo ""
echo "Pushing workspace template ($WORKSPACE_TEMPLATE_NAME)..."
coder templates push "$WORKSPACE_TEMPLATE_NAME" \
  --directory "$WORKSPACE_TEMPLATE_DIR" \
  "${COMMON_VARS[@]}" \
  --variable "workspace_access_role_arn=$ACCESS_ROLE_ARN" \
  --yes

# --- Push task template ---
echo ""
echo "Pushing task template ($TASK_TEMPLATE_NAME)..."
coder templates push "$TASK_TEMPLATE_NAME" \
  --directory "$TASK_TEMPLATE_DIR" \
  "${COMMON_VARS[@]}" \
  --yes

echo ""
echo "Done. Templates '$WORKSPACE_TEMPLATE_NAME' and '$TASK_TEMPLATE_NAME' updated."
