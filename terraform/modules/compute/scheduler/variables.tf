variable "project_name" {
  description = "Project name used in resource names"
  type        = string
}

variable "environment" {
  description = "Deployment environment"
  type        = string
}

variable "vpc_id" {
  description = "VPC hosting the cache and the scheduler's ENIs"
  type        = string
}

variable "vpc_cidr" {
  description = "VPC CIDR, used to carve the scheduler and executor subnets"
  type        = string
}

variable "private_route_table_ids" {
  description = "NAT-routed private route tables the executor subnets attach to"
  type        = list(string)
}

variable "availability_zones" {
  description = "AZ names for the cache and executor subnets"
  type        = list(string)
}

variable "environment_registry_table_name" {
  description = "Managed environment registry table (read: launch specs and revisions)"
  type        = string
}

variable "environment_registry_table_arn" {
  description = "Managed environment registry table ARN"
  type        = string
}

variable "v2_executions_table_arn" {
  description = "v2 executions table ARN — the scheduler reads job/execution state"
  type        = string
}

variable "agent_credential_grant_secret_param_name" {
  description = "SSM parameter holding the agent credential grant signing secret"
  type        = string
}

variable "agentcore_runtime_arn" {
  description = "Protected AgentCore runtime ARN, for the wake provisioner"
  type        = string
}

variable "executor_instance_profile_arn" {
  description = "Instance profile the launch templates attach to workers"
  type        = string
}

variable "executor_role_arn" {
  description = "Worker instance role ARN (needed for iam:PassRole on CreateFleet)"
  type        = string
}

variable "lease_idle_ms" {
  description = "How long a claimed job may go unbeaten before the sweep abandons it. Must stay BELOW the orchestrator's 15-minute stage callback heartbeat so the scheduler notices a dead worker first."
  type        = number
  default     = 300000
}

variable "reconcile_interval_minutes" {
  description = "How often the reconcile sweep runs"
  type        = number
  default     = 5
}

variable "tags" {
  description = "Tags applied to resources"
  type        = map(string)
  default     = {}
}
