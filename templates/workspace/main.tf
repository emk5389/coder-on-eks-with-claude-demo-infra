terraform {
  required_providers {
    coder      = { source = "coder/coder" }
    kubernetes = { source = "hashicorp/kubernetes" }
  }
}

provider "coder" {}
provider "kubernetes" { config_path = null }

# ────────────────────────────────────
# Template-level variables
# ────────────────────────────────────
variable "namespace" {
  type    = string
  default = "coder"
}

variable "image" {
  type        = string
  description = "ECR URI of the workspace image built from docker/workspace/Dockerfile"
}

variable "repo_url" {
  type    = string
  default = "https://github.com/emk5389/coder-on-eks-with-claude-demo-app.git"
}

variable "workspace_irsa_role_arn" {
  type        = string
  description = "Output of CoderDemoWorkspaceIam stack"
}

variable "coder_deployment_host" {
  type        = string
  description = "e.g. coder.example.com — used by the preview-urls skill"
}

variable "workspace_access_role_arn" {
  type        = string
  description = "ARN of the dev-resources access role (output of the demo-app CDK's DocChatDevResources stack)"
  default     = ""
}

variable "documents_bucket" {
  type        = string
  description = "Name of the documents S3 bucket (output of the demo-app CDK's DocChatDevResources stack)"
  default     = ""
}

variable "jira_url" {
  type        = string
  description = "Jira instance URL (e.g. https://your-org.atlassian.net). Leave empty to disable Jira integration."
  default     = ""
}

# ────────────────────────────────────
# User-facing parameters
# ────────────────────────────────────
data "coder_parameter" "disk_gb" {
  name         = "disk_gb"
  display_name = "Disk size (GB)"
  type         = "number"
  default      = "50"
  mutable      = false
}

# ────────────────────────────────────
# Coder data sources
# ────────────────────────────────────
data "coder_workspace" "me" {}
data "coder_workspace_owner" "me" {}
data "coder_external_auth" "github" {
  id       = "github"
  optional = true
}

# ────────────────────────────────────
# Coder agent
# ────────────────────────────────────
resource "coder_agent" "main" {
  arch = "amd64"
  os   = "linux"
  dir  = "/home/coder/workspace"

  startup_script_behavior = "blocking"

  startup_script = templatefile("${path.module}/startup.sh", {
    git_user_name  = data.coder_workspace_owner.me.full_name
    git_user_email = data.coder_workspace_owner.me.email
    repo_url       = var.repo_url
  })

  env = {
    DOCKER_HOST              = "tcp://127.0.0.1:2375"
    TERM                     = "xterm-256color"
    COLORTERM                = "truecolor"
    CODER_DEPLOYMENT_HOST    = var.coder_deployment_host
  }

  display_apps {
    web_terminal = true
    ssh_helper   = true
    vscode       = true
  }
}

# ────────────────────────────────────
# Web preview app
# ────────────────────────────────────
resource "coder_app" "preview" {
  agent_id     = coder_agent.main.id
  slug         = "preview"
  display_name = "Web App Preview"
  url          = "http://localhost:3000"
  icon         = "/icon/globe.svg"
  share        = "authenticated"
  subdomain    = true
}

resource "coder_app" "api" {
  agent_id     = coder_agent.main.id
  slug         = "api"
  display_name = "API"
  url          = "http://localhost:8000"
  icon         = "/icon/code.svg"
  share        = "authenticated"
}

# ────────────────────────────────────
# Claude Code module (with MCP injection)
# ────────────────────────────────────
module "claude_code" {
  source                  = "registry.coder.com/coder/claude-code/coder"
  agent_id                = coder_agent.main.id
  workdir                 = "/home/coder/workspace"
  claude_code_version     = "2.1.77"
  claude_code_oauth_token = "" # Fetched at runtime from Secrets Manager via fetch-workspace-secrets.sh
  mcp = jsonencode({
    mcpServers = {
      atlassian = {
        command = "uvx"
        args    = ["mcp-atlassian"]
      }
      playwright = {
        command = "npx"
        args    = ["@playwright/mcp@latest", "--headless", "--viewport-size=1280x720"]
      }
    }
  })
}

# ────────────────────────────────────
# Persistent volume
# ────────────────────────────────────
resource "kubernetes_persistent_volume_claim_v1" "home" {
  metadata {
    name      = "coder-${data.coder_workspace_owner.me.name}-${data.coder_workspace.me.name}"
    namespace = var.namespace
  }
  wait_until_bound = false
  spec {
    access_modes       = ["ReadWriteOnce"]
    storage_class_name = "gp3"
    resources {
      requests = { storage = "${data.coder_parameter.disk_gb.value}Gi" }
    }
  }
  lifecycle { ignore_changes = all }
}

# ────────────────────────────────────
# Workspace ServiceAccount (annotated for IRSA)
# ────────────────────────────────────
resource "kubernetes_service_account_v1" "workspace" {
  metadata {
    name      = "workspace-${data.coder_workspace_owner.me.name}-${data.coder_workspace.me.name}"
    namespace = var.namespace
    annotations = {
      "eks.amazonaws.com/role-arn" = var.workspace_irsa_role_arn
    }
  }
}

# ────────────────────────────────────
# Workspace pod
# ────────────────────────────────────
resource "kubernetes_pod_v1" "workspace" {
  count = data.coder_workspace.me.start_count

  timeouts { create = "15m" }

  metadata {
    name      = "coder-${data.coder_workspace_owner.me.name}-${data.coder_workspace.me.name}"
    namespace = var.namespace
    labels = {
      "app.kubernetes.io/name"     = "coder-workspace"
      "app.kubernetes.io/instance" = data.coder_workspace.me.name
    }
  }

  spec {
    node_selector        = { role = "workspace" }
    service_account_name = kubernetes_service_account_v1.workspace.metadata[0].name

    security_context { fs_group = "1000" }

    volume {
      name = "home"
      persistent_volume_claim {
        claim_name = kubernetes_persistent_volume_claim_v1.home.metadata[0].name
      }
    }

    init_container {
      name    = "init-chmod"
      image   = "busybox:latest"
      command = ["sh", "-c", "chown -R 1000:1000 /home/coder"]
      security_context { run_as_user = "0" }
      volume_mount {
        name       = "home"
        mount_path = "/home/coder"
      }
    }

    container {
      name  = "dev"
      image = var.image

      command = ["sh", "-c", "/usr/local/bin/fetch-workspace-secrets.sh; export BASH_ENV=/home/coder/.workspace-secrets; ${coder_agent.main.init_script}"]

      security_context { run_as_user = "1000" }

      env {
        name  = "CODER_AGENT_TOKEN"
        value = coder_agent.main.token
      }
      env {
        name  = "CODER_URL"
        value = "https://${var.coder_deployment_host}"
      }
      env {
        name  = "CODER_WORKSPACE_OWNER"
        value = data.coder_workspace_owner.me.name
      }
      env {
        name  = "CODER_WORKSPACE_NAME"
        value = data.coder_workspace.me.name
      }
      env {
        name  = "DOCKER_HOST"
        value = "tcp://127.0.0.1:2375"
      }
      env {
        name  = "WORKSPACE_ACCESS_ROLE_ARN"
        value = var.workspace_access_role_arn
      }
      env {
        name  = "JIRA_USERNAME"
        value = data.coder_workspace_owner.me.email
      }
      env {
        name  = "JIRA_URL"
        value = var.jira_url
      }
      env {
        name  = "GITHUB_TOKEN"
        value = data.coder_external_auth.github.access_token
      }
      env {
        name  = "DOCUMENTS_BUCKET"
        value = var.documents_bucket
      }

      resources {
        requests = {
          cpu    = "1500m"
          memory = "6Gi"
        }
      }

      volume_mount {
        name       = "home"
        mount_path = "/home/coder"
      }
    }

    container {
      name  = "docker-sidecar"
      image = "docker:dind"

      security_context {
        privileged  = true
        run_as_user = 0
      }

      command = ["dockerd", "-H", "tcp://127.0.0.1:2375", "--data-root", "/home/coder/.docker-data"]

      resources {
        requests = {
          cpu    = "1500m"
          memory = "6Gi"
        }
      }

      volume_mount {
        name       = "home"
        mount_path = "/home/coder"
      }
    }
  }
}
