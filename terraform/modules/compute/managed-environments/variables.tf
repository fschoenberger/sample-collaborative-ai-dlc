variable "project_name" {
  description = "Project name used in resource names"
  type        = string
}

variable "environment" {
  description = "Deployment environment"
  type        = string
}

variable "registry_table_name" {
  description = "Managed environment registry table name"
  type        = string
}

variable "registry_table_arn" {
  description = "Managed environment registry table ARN"
  type        = string
}

variable "core_image_uri" {
  description = "Protected AgentCore image repository URL"
  type        = string
}

variable "core_image_digest" {
  description = "Immutable protected AgentCore image digest"
  type        = string
}

variable "core_image_size_bytes" {
  description = "Compressed size of the protected AgentCore image"
  type        = number
}

variable "core_runtime_arn" {
  description = "Protected AgentCore runtime ARN"
  type        = string
}

variable "core_runtime_version" {
  description = "Protected AgentCore runtime version"
  type        = string
}

variable "runtime_compatibility_version" {
  description = "Protected runtime contract version"
  type        = string
}

variable "runtime_role_arn" {
  description = "Execution role used by managed AgentCore runtimes"
  type        = string
}

variable "runtime_network_mode" {
  description = "Network mode inherited by managed AgentCore runtimes"
  type        = string
}

variable "runtime_subnet_ids" {
  description = "Subnets inherited by managed AgentCore runtimes"
  type        = list(string)
}

variable "runtime_security_group_ids" {
  description = "Security groups inherited by managed AgentCore runtimes"
  type        = list(string)
}

variable "runtime_environment_variables" {
  description = "Protected environment variables inherited by managed AgentCore runtimes"
  type        = map(string)
}

variable "core_repository_arn" {
  description = "Protected AgentCore ECR repository ARN"
  type        = string
}

variable "environment_repository_name" {
  description = "Managed environment ECR repository name"
  type        = string
}

variable "environment_repository_url" {
  description = "Managed environment ECR repository URL"
  type        = string
}

variable "environment_repository_arn" {
  description = "Managed environment ECR repository ARN"
  type        = string
}

variable "cors_allowed_origins" {
  description = "Comma-separated CORS origins"
  type        = string
}

variable "tags" {
  description = "Tags applied to resources"
  type        = map(string)
  default     = {}
}

# ── EC2 environment ingredients ─────────────────────────────────────────────
# An EC2 environment has nothing to build: the operator brings the AMI. What this
# lambda does need is everything a per-revision launch template must carry, so a
# worker booted from that template can find its queue and do its job. Empty
# defaults mean "EC2 environments are not configured here", and the API says so
# rather than creating a template that cannot work.

variable "executor_instance_profile_arn" {
  description = "Instance profile attached to workers by the per-revision launch template"
  type        = string
  default     = ""
}

variable "executor_security_group_id" {
  description = "Platform security group every worker gets, before any operator ones"
  type        = string
  default     = ""
}

variable "valkey_host" {
  description = "Valkey endpoint a worker connects to for its job queue"
  type        = string
  default     = ""
}

variable "valkey_port" {
  description = "Valkey endpoint port"
  type        = string
  default     = "6379"
}

variable "scheduler_function_name" {
  description = "Scheduler function a worker calls for issue-grant at claim time"
  type        = string
  default     = ""
}

variable "v2_process_table_name" {
  description = "v2 process/state table a worker reads and writes"
  type        = string
  default     = ""
}

variable "artifacts_bucket_name" {
  description = "Artifacts bucket (block bodies, methodology snapshot)"
  type        = string
  default     = ""
}

variable "neptune_endpoint" {
  description = "Neptune endpoint for the graph"
  type        = string
  default     = ""
}

variable "connections_table_name" {
  description = "Websocket connections table for live output"
  type        = string
  default     = ""
}

variable "websocket_endpoint" {
  description = "Websocket management endpoint"
  type        = string
  default     = ""
}

variable "blocks_table_name" {
  description = "Blocks table (read)"
  type        = string
  default     = ""
}

variable "aidlc_repo_ref" {
  description = "Pinned upstream methodology ref"
  type        = string
  default     = ""
}

variable "bedrock_model" {
  description = "Default model id"
  type        = string
  default     = ""
}
